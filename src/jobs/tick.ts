import { Api } from 'grammy';
import { DateTime } from 'luxon';
import * as views from '../bot/views.js';
import { config } from '../config.js';
import * as repo from '../db.js';
import { type Notice, plan } from '../domain/planner.js';
import { isOpen } from '../domain/types.js';
import * as svc from '../services/lessons.js';
import { lessonStart, nowIn } from '../time.js';
import { runAs } from '../user.js';

export interface TickResult {
  at: string;
  generated: number;
  sent: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Один «тик» планировщика по всем пользователям. Вызывается pg_cron каждые 5 минут.
 * Идемпотентен: создание занятий через уникальный slot_key, уведомления — через ключи в notifications.
 * Ключи в результате — с префиксом Telegram id пользователя.
 */
export async function runTick(now: DateTime = nowIn(config().TIME_ZONE)): Promise<TickResult> {
  const cfg = config();
  const api = new Api(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_API_ROOT ? { apiRoot: cfg.TELEGRAM_API_ROOT } : {});
  const result: TickResult = { at: now.toISO() as string, generated: 0, sent: [], skipped: [], errors: [] };
  for (const userId of cfg.ALLOWED_TELEGRAM_IDS) {
    // Ошибка одного пользователя не мешает остальным
    try {
      const own = await runAs(userId, () => runUserTick(api, userId, now));
      result.generated += own.generated;
      result.sent.push(...own.sent.map((k) => `${userId}/${k}`));
      result.skipped.push(...own.skipped.map((k) => `${userId}/${k}`));
      result.errors.push(...own.errors.map((e) => `${userId}/${e}`));
    } catch (error) {
      result.errors.push(`${userId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/** Тик одного пользователя; личный чат с ботом имеет тот же id, что и пользователь. */
async function runUserTick(api: Api, chatId: number, now: DateTime): Promise<TickResult> {
  const cfg = config();
  const result: TickResult = { at: now.toISO() as string, generated: 0, sent: [], skipped: [], errors: [] };

  result.generated = await svc.materializeSchedule(now);

  const [snap, sent, snoozeIso] = await Promise.all([
    svc.loadSnapshot(now),
    repo.getSentNotificationKeys(now.minus({ days: 30 }).toUTC().toISO() as string),
    repo.getState<string>('pay_snooze_until'),
  ]);

  const notices = plan({
    now,
    zone: cfg.TIME_ZONE,
    lessons: snap.nearby,
    balance: snap.balance,
    sent,
    paySnoozedUntil: snoozeIso ? DateTime.fromISO(snoozeIso) : null,
    settings: {
      morningHour: cfg.MORNING_HOUR,
      postLessonDelayMin: cfg.POST_LESSON_DELAY_MIN,
      payRemindThreshold: cfg.PAY_REMIND_THRESHOLD,
      payRemindHour: cfg.PAY_REMIND_HOUR,
      weeklyDigest: cfg.WEEKLY_DIGEST === 'on',
      weeklyDigestHour: cfg.WEEKLY_DIGEST_HOUR,
      autoDoneAfterHours: cfg.AUTO_DONE_AFTER_HOURS,
      homework: cfg.HOMEWORK_REMINDERS === 'on',
      homeworkHour: cfg.HOMEWORK_HOUR,
    },
  });

  for (const notice of notices) {
    // Сначала «занимаем» ключ — параллельный тик его уже не отправит.
    const claimed = await repo.claimNotification(notice.key, { kind: notice.kind });
    if (!claimed) {
      result.skipped.push(notice.key);
      continue;
    }
    try {
      const messageId = await deliver(api, chatId, notice, now);
      if (messageId) await repo.setNotificationMessage(notice.key, messageId);
      result.sent.push(notice.key);
    } catch (error) {
      // Не получилось — освобождаем ключ, следующий тик попробует снова.
      await repo.releaseNotification(notice.key).catch(() => undefined);
      result.errors.push(`${notice.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

async function deliver(api: Api, chatId: number, notice: Notice, now: DateTime): Promise<number | null> {
  const cfg = config();
  const zone = cfg.TIME_ZONE;

  switch (notice.kind) {
    case 'homework': {
      // ДЗ могли отметить, а занятие — отменить или перенести между расчётом и отправкой
      const lesson = await repo.getLesson(notice.lesson.id);
      if (!lesson || !isOpen(lesson.status) || lesson.homework_done_at) return null;
      const msg = await api.sendMessage(chatId, views.homeworkText(lesson, zone, now), {
        reply_markup: views.homeworkKeyboard(lesson),
      });
      return msg.message_id;
    }
    case 'morning': {
      // Занятие могли закрыть между расчётом и отправкой
      const lesson = await repo.getLesson(notice.lesson.id);
      if (lesson?.status !== 'planned') return null;
      const msg = await api.sendMessage(chatId, views.morningText(lesson, zone), {
        reply_markup: views.morningKeyboard(lesson),
      });
      return msg.message_id;
    }
    case 'post':
    case 'post_nag': {
      const lesson = await repo.getLesson(notice.lesson.id);
      if (!lesson || !isOpen(lesson.status)) return null;
      const msg = await api.sendMessage(chatId, views.postText(lesson, zone, notice.kind === 'post_nag'), {
        reply_markup: views.postKeyboard(lesson),
      });
      return msg.message_id;
    }
    case 'auto_done': {
      const lesson = await repo.getLesson(notice.lesson.id);
      if (!lesson || !isOpen(lesson.status)) return null;
      const res = await svc.setLessonStatus(lesson, 'done', 'отмечено автоматически');
      const msg = await api.sendMessage(chatId, views.autoDoneText(lesson, zone), {
        reply_markup: views.undoKeyboard(res.logId),
      });
      return msg.message_id;
    }
    case 'payment': {
      // Пересчитываем: оплату могли записать только что
      const snap = await svc.loadSnapshot(now);
      if (snap.balance.paidAhead > cfg.PAY_REMIND_THRESHOLD || snap.balance.upcoming.length === 0) return null;
      const msg = await api.sendMessage(chatId, views.paymentText(snap.balance, zone, now), {
        reply_markup: views.paymentKeyboard(cfg.PACK_SIZE),
      });
      return msg.message_id;
    }
    case 'weekly': {
      const weekStart = now.minus({ days: 6 }).startOf('day');
      const [week, snap] = await Promise.all([
        repo.getLessonsBetween(weekStart.toUTC().toISO() as string, now.toUTC().toISO() as string),
        svc.loadSnapshot(now),
      ]);
      const inWeek = week.filter((l) => lessonStart(l, zone) >= weekStart);
      const msg = await api.sendMessage(chatId, views.weeklyText(inWeek, snap.balance, zone, now));
      return msg.message_id;
    }
  }
}
