import { randomBytes } from 'node:crypto';
import { Bot, type Context, GrammyError } from 'grammy';
import type { DateTime } from 'luxon';
import { config } from '../config.js';
import * as repo from '../db.js';
import { parseScheduleArgs } from '../domain/schedule.js';
import { isOpen } from '../domain/types.js';
import { isLlmConfigured, LlmUnavailableError } from '../llm/client.js';
import { buildRefs, parseIntentWithLlm } from '../llm/parse-intent.js';
import { extractDate, parseDateTime } from '../nlu/datetime.js';
import { type Intent, MUTATING_INTENTS } from '../nlu/intent.js';
import { parseByRules } from '../nlu/rules.js';
import * as svc from '../services/lessons.js';
import { buildMonthStats } from '../services/stats.js';
import { fmtShort, lessonStart, nowIn } from '../time.js';
import { describeAction, performAction, type Reply, type ResolvedAction, resolveIntent } from './actions.js';
import * as views from './views.js';

type AwaitState = { kind: 'reschedule'; lessonId: string } | { kind: 'amount'; paymentId: string };

const COMMANDS = [
  { command: 'status', description: 'Сколько осталось и ближайшие занятия' },
  { command: 'paid', description: 'Записать оплату: /paid 4 8000' },
  { command: 'setbalance', description: 'Выставить остаток оплаченных' },
  { command: 'add', description: 'Разовое занятие: /add 5.11 18:00' },
  { command: 'hw', description: 'ДЗ к ближайшему занятию сделано' },
  { command: 'schedule', description: 'Расписание и паузы' },
  { command: 'pause', description: 'Перерыв: /pause 28.12 10.01' },
  { command: 'history', description: 'Последние занятия и оплаты' },
  { command: 'stats', description: 'Статистика по месяцам' },
  { command: 'undo', description: 'Отменить последнее действие' },
  { command: 'help', description: 'Что я умею' },
];

export const BOT_COMMANDS = COMMANDS;

let instance: Bot | undefined;

export function getBot(): Bot {
  if (instance) return instance;
  const cfg = config();
  const bot = new Bot(cfg.TELEGRAM_BOT_TOKEN, {
    client: cfg.TELEGRAM_API_ROOT ? { apiRoot: cfg.TELEGRAM_API_ROOT } : {},
  });

  // Только владелец. Остальным — вежливый отказ и их id (удобно при первой настройке).
  bot.use(async (ctx, next) => {
    if (ctx.from?.id === cfg.OWNER_TELEGRAM_ID) return next();
    if (ctx.chat?.type === 'private' && ctx.message) {
      await ctx.reply(`Это личный бот. Ваш Telegram id: ${ctx.from?.id ?? 'неизвестен'}`);
    }
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  });

  // ---------- Команды ----------

  bot.command('start', async (ctx) => {
    await svc.materializeSchedule(nowIn(cfg.TIME_ZONE));
    const snap = await svc.loadSnapshot();
    const firstRun = snap.balance.credits === 0 && snap.balance.used === 0;
    const intro = firstRun
      ? '\n\nДля начала скажи, сколько оплаченных занятий у тебя сейчас осталось: /setbalance 3 (или просто напиши «осталось 3 оплаченных»).'
      : '';
    await ctx.reply(`${views.HELP_TEXT}${intro}`);
  });

  bot.command('help', (ctx) => ctx.reply(views.HELP_TEXT));

  bot.command('status', async (ctx) => {
    await sendReply(ctx, await statusReply());
  });

  bot.command('history', async (ctx) => {
    const [lessons, payments] = await Promise.all([repo.getRecentResolvedLessons(12), repo.getRecentPayments(6)]);
    await ctx.reply(views.historyText(lessons, payments, cfg.TIME_ZONE));
  });

  bot.command('stats', async (ctx) => {
    await ctx.reply(await statsReply());
  });

  bot.command('schedule', async (ctx) => {
    const args = ctx.match.trim();
    if (!args) {
      await ctx.reply(await scheduleReply());
      return;
    }
    const specs = parseScheduleArgs(args, cfg.DEFAULT_DURATION_MIN);
    if (!specs) {
      await ctx.reply('Не понял расписание. Примеры:\n/schedule пн ср 16:40\n/schedule пн 16:40 чт 18:00 90');
      return;
    }
    const res = await svc.applySchedule(specs, nowIn(cfg.TIME_ZONE));
    await ctx.reply(`Расписание обновлено. Создано занятий вперёд: ${res.created}.\n\n${await scheduleReply()}`);
  });

  bot.command('paid', async (ctx) => {
    const numbers = (ctx.match.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(',', '.')));
    const [first, second] = numbers;
    let lessons = cfg.PACK_SIZE;
    let amount: number | null = null;
    if (first !== undefined && first >= 100) amount = first;
    else if (first !== undefined) lessons = first;
    if (second !== undefined) amount = second;
    if (!Number.isInteger(lessons) || lessons < 1 || lessons > 100) {
      await ctx.reply('Число занятий должно быть от 1 до 100. Пример: /paid 4 8000');
      return;
    }
    await sendReply(ctx, await performAction({ type: 'payment', lessons, amount }));
  });

  bot.command('setbalance', async (ctx) => {
    const n = Number.parseInt(ctx.match.trim(), 10);
    if (!Number.isFinite(n) || n < -50 || n > 200) {
      await ctx.reply('Укажи, сколько оплаченных занятий осталось сейчас: /setbalance 3');
      return;
    }
    await sendReply(ctx, await performAction({ type: 'set_balance', remaining: n }));
  });

  bot.command('add', async (ctx) => {
    const args = ctx.match.trim();
    const now = nowIn(cfg.TIME_ZONE);
    const durationMatch = /\s(\d{2,3})\s*(мин)?$/.exec(args);
    const duration = durationMatch ? Number(durationMatch[1]) : cfg.DEFAULT_DURATION_MIN;
    const when = parseDateTime(durationMatch ? args.slice(0, durationMatch.index) : args, now);
    if (!args || !when) {
      await ctx.reply('Укажи дату и время: /add 5.11 18:00 или /add пт 18:00 90');
      return;
    }
    await sendReply(
      ctx,
      await performAction({ type: 'add_lesson', start: when.toISO() as string, durationMin: duration }),
    );
  });

  bot.command('pause', async (ctx) => {
    const now = nowIn(cfg.TIME_ZONE);
    const parts = ctx.match
      .trim()
      .split(/\s*(?:—|–|-|\s по\s|\s)\s*/)
      .filter((p) => p && p !== 'с' && p !== 'по');
    const from = parts[0] ? extractDate(parts[0], now) : null;
    const to = parts[1] ? extractDate(parts[1], from ?? now) : from;
    if (!from || !to) {
      await ctx.reply('Укажи даты паузы: /pause 28.12 10.01 (или одну дату — на один день)');
      return;
    }
    if (to < from) {
      await ctx.reply('Конец паузы раньше начала — проверь даты.');
      return;
    }
    await sendReply(
      ctx,
      await performAction({ type: 'pause', from: from.toISODate() as string, to: to.toISODate() as string }),
    );
  });

  bot.command('hw', async (ctx) => {
    const snap = await svc.loadSnapshot();
    const lesson = svc.pickDefaultLesson('homework', snap.balance.upcoming, snap.now, snap.zone);
    if (!lesson) {
      await ctx.reply('Впереди нет запланированных занятий.');
      return;
    }
    await sendReply(ctx, await performAction({ type: 'homework', lessonId: lesson.id }));
  });

  bot.command('undo', async (ctx) => {
    await sendReply(ctx, await performAction({ type: 'undo' }));
  });

  bot.command('cancel', async (ctx) => {
    await repo.deleteState('await');
    await ctx.reply('Ок, отменил ожидание ответа.');
  });

  // ---------- Кнопки ----------

  bot.callbackQuery(/^ls:(done|cancelled|burned|confirmed):([0-9a-f-]{36})$/, async (ctx) => {
    const [, status, lessonId] = ctx.match as RegExpMatchArray as [
      string,
      'done' | 'cancelled' | 'burned' | 'confirmed',
      string,
    ];
    await ctx.answerCallbackQuery();
    const reply = await performAction({ type: 'status', lessonId, status });
    await closeButtons(ctx);
    await sendReply(ctx, reply);
  });

  bot.callbackQuery(/^hw:([0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const reply = await performAction({ type: 'homework', lessonId: ctx.match[1] as string });
    await closeButtons(ctx);
    await sendReply(ctx, reply);
  });

  bot.callbackQuery(/^lr:([0-9a-f-]{36})$/, async (ctx) => {
    const lessonId = ctx.match[1] as string;
    await ctx.answerCallbackQuery();
    const lesson = await repo.getLesson(lessonId);
    if (!lesson || !isOpen(lesson.status)) {
      await ctx.reply('Это занятие уже закрыто.');
      return;
    }
    await repo.setState('await', { kind: 'reschedule', lessonId } satisfies AwaitState, 60);
    await closeButtons(ctx);
    await ctx.reply(
      `На когда перенесли занятие ${fmtShort(lessonStart(lesson, cfg.TIME_ZONE))}?\nНапример: «чт 18:00», «завтра в 17», «5.11 16:40». /cancel — отмена.`,
    );
  });

  bot.callbackQuery(/^pay:(\d{1,3})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await closeButtons(ctx);
    await sendReply(ctx, await performAction({ type: 'payment', lessons: Number(ctx.match[1]), amount: null }));
  });

  bot.callbackQuery('pay:snooze', async (ctx) => {
    const tomorrow = nowIn(cfg.TIME_ZONE).plus({ days: 1 }).startOf('day').set({ hour: cfg.PAY_REMIND_HOUR });
    await repo.setState('pay_snooze_until', tomorrow.toISO());
    await ctx.answerCallbackQuery({ text: 'Напомню завтра' });
    await closeButtons(ctx);
  });

  bot.callbackQuery(/^undo:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const res = await svc.undo(Number(ctx.match[1]));
    await closeButtons(ctx);
    await ctx.reply(res ? `↩️ Отменил: ${res.summary}.` : 'Это действие уже отменено.');
  });

  bot.callbackQuery(/^int:(ok|no):([A-Za-z0-9_-]{6,32})$/, async (ctx) => {
    const [, answer, token] = ctx.match as RegExpMatchArray as [string, 'ok' | 'no', string];
    await ctx.answerCallbackQuery();
    const key = `intent:${token}`;
    const action = await repo.getState<ResolvedAction>(key);
    await repo.deleteState(key);
    await closeButtons(ctx);
    if (answer === 'no') {
      await ctx.reply('Ок, ничего не меняю. Можно сформулировать иначе или воспользоваться командами — /help.');
      return;
    }
    if (!action) {
      await ctx.reply('Подтверждение устарело, повтори, пожалуйста.');
      return;
    }
    await sendReply(ctx, await performAction(action));
  });

  // ---------- Свободный текст ----------

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      await ctx.reply('Не знаю такой команды. /help');
      return;
    }
    const now = nowIn(cfg.TIME_ZONE);

    // 1. Ждём конкретный ответ (время переноса или сумму оплаты)
    const awaiting = await repo.getState<AwaitState>('await');
    if (awaiting?.kind === 'reschedule') {
      const handled = await handleRescheduleAnswer(ctx, awaiting.lessonId, text, now);
      if (handled) return;
    }
    if (awaiting?.kind === 'amount') {
      const amount = Number(
        text
          .replace(/\s/g, '')
          .replace(',', '.')
          .replace(/(₽|р|руб\.?|рублей)$/i, ''),
      );
      if (Number.isFinite(amount) && amount >= 0) {
        await repo.deleteState('await');
        await repo.updateRow('payments', awaiting.paymentId, { amount });
        await ctx.reply(`Сумма сохранена: ${amount} ₽.`);
        return;
      }
      await repo.deleteState('await');
    }

    // 2. Простые фразы — без модели и сразу (с кнопкой «отменить»)
    const rule = parseByRules(text, { now, packSize: cfg.PACK_SIZE });
    if (rule) {
      await handleIntent(ctx, rule, { confirm: false });
      return;
    }

    // 3. Всё остальное — модель, с подтверждением изменений
    if (!isLlmConfigured()) {
      await ctx.reply('Не понял. Без подключённой модели я понимаю только простые фразы и команды — /help.');
      return;
    }
    await ctx.replyWithChatAction('typing');
    await handleIntent(ctx, text, { confirm: true });
  });

  bot.catch(async (err) => {
    console.error('Bot error', err.error);
    const isTelegramNoise =
      err.error instanceof GrammyError && /message is not modified|query is too old/.test(err.error.description);
    if (isTelegramNoise) return;
    try {
      await err.ctx.reply('Что-то пошло не так 😕 Попробуй ещё раз или используй команду из /help.');
    } catch {
      // ignore
    }
  });

  instance = bot;
  return bot;
}

// ---------- Вспомогательное ----------

async function sendReply(ctx: Context, reply: Reply): Promise<void> {
  await ctx.reply(reply.text, reply.keyboard ? { reply_markup: reply.keyboard } : {});
}

/** Убирает кнопки у сообщения, на которое нажали, чтобы не нажать дважды. */
async function closeButtons(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  } catch {
    // сообщение слишком старое или уже без кнопок
  }
}

async function statusReply(): Promise<Reply> {
  const cfg = config();
  await svc.materializeSchedule(nowIn(cfg.TIME_ZONE));
  const snap = await svc.loadSnapshot();
  const needPay = snap.balance.upcoming.length > 0 && snap.balance.paidAhead <= cfg.PAY_REMIND_THRESHOLD;
  return {
    text: views.statusText(snap.balance, snap.zone, snap.now),
    keyboard: needPay ? views.paymentKeyboard(cfg.PACK_SIZE) : undefined,
  };
}

async function scheduleReply(): Promise<string> {
  const cfg = config();
  const [slots, pauses] = await Promise.all([
    repo.getActiveSlots(),
    repo.getPauses(nowIn(cfg.TIME_ZONE).toISODate() as string),
  ]);
  return views.scheduleText(slots, pauses);
}

async function statsReply(): Promise<string> {
  const cfg = config();
  const since = nowIn(cfg.TIME_ZONE).minus({ months: 12 }).startOf('month').toUTC().toISO() as string;
  const [lessons, payments] = await Promise.all([repo.getAllLessonsSince(since), repo.getPaymentsSince(since)]);
  return views.statsText(buildMonthStats(lessons, payments, cfg.TIME_ZONE));
}

async function handleRescheduleAnswer(ctx: Context, lessonId: string, text: string, now: DateTime): Promise<boolean> {
  const cfg = config();
  const lesson = await repo.getLesson(lessonId);
  if (!lesson || !isOpen(lesson.status)) {
    await repo.deleteState('await');
    return false;
  }
  const original = lessonStart(lesson, cfg.TIME_ZONE);
  const when = parseDateTime(text, now, { defaultTime: { hour: original.hour, minute: original.minute } });
  if (!when) {
    await ctx.reply('Не понял время. Например: «чт 18:00», «завтра в 17», «5.11 16:40». /cancel — отмена.');
    return true;
  }
  await repo.deleteState('await');
  await sendReply(ctx, await performAction({ type: 'reschedule', lessonId, newStart: when.toISO() as string }));
  return true;
}

async function handleIntent(ctx: Context, input: Intent | string, opts: { confirm: boolean }): Promise<void> {
  const cfg = config();
  const snap = await svc.loadSnapshot();
  const open = [...snap.balance.pendingPast, ...snap.balance.upcoming];
  // Для модели — занятия рядом с сегодняшним днём, кроме перенесённых-закрытых
  const refs = buildRefs(
    snap.nearby.filter((l) => {
      const start = lessonStart(l, snap.zone);
      return l.status !== 'rescheduled' && start > snap.now.minus({ days: 7 }) && start < snap.now.plus({ days: 15 });
    }),
  );

  let intent: Intent;
  if (typeof input === 'string') {
    try {
      intent = await parseIntentWithLlm(input, {
        now: snap.now,
        zone: snap.zone,
        packSize: cfg.PACK_SIZE,
        remaining: snap.balance.remaining,
        refs,
      });
    } catch (error) {
      console.error('LLM parse failed', error);
      const why = error instanceof LlmUnavailableError ? 'модель сейчас недоступна' : 'не смог разобрать фразу';
      await ctx.reply(
        `Не понял: ${why}. Попробуй проще («было», «перенесли на чт 18:00», «оплатил 4») или командой — /help.`,
      );
      return;
    }
  } else {
    intent = input;
  }

  if (intent.type === 'chat') {
    await ctx.reply(intent.reply);
    return;
  }
  if (intent.type === 'query') {
    if (intent.what === 'status') await sendReply(ctx, await statusReply());
    if (intent.what === 'history') {
      const [lessons, payments] = await Promise.all([repo.getRecentResolvedLessons(12), repo.getRecentPayments(6)]);
      await ctx.reply(views.historyText(lessons, payments, cfg.TIME_ZONE));
    }
    if (intent.what === 'stats') await ctx.reply(await statsReply());
    if (intent.what === 'schedule') await ctx.reply(await scheduleReply());
    return;
  }

  const resolved = resolveIntent(intent, {
    now: snap.now,
    zone: snap.zone,
    open,
    refs,
    defaultDuration: cfg.DEFAULT_DURATION_MIN,
  });
  if (resolved === null) {
    await ctx.reply('Не понял, что сделать. /help');
    return;
  }
  if (typeof resolved === 'string') {
    await ctx.reply(resolved);
    return;
  }

  if (opts.confirm && MUTATING_INTENTS.has(intent.type)) {
    const token = randomBytes(9).toString('base64url');
    await repo.setState(`intent:${token}`, resolved, 30);
    await ctx.reply(`Понял так:\n${await describeAction(resolved)}\n\nВерно?`, {
      reply_markup: views.confirmKeyboard(token),
    });
    return;
  }

  await sendReply(ctx, await performAction(resolved));
}
