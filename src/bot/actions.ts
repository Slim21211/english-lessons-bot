import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import * as repo from '../db.js';
import { isCharged, type Lesson, type LessonStatus } from '../domain/types.js';
import type { LessonRef } from '../llm/parse-intent.js';
import type { Intent } from '../nlu/intent.js';
import * as svc from '../services/lessons.js';
import { fmtShort, lessonStart, lessonsWord } from '../time.js';
import { cb } from './views.js';

/** Намерение, привязанное к конкретным записям, — его можно сохранить и выполнить позже. */
export type ResolvedAction =
  | { type: 'status'; lessonId: string; status: Exclude<LessonStatus, 'planned' | 'rescheduled'> }
  | { type: 'reschedule'; lessonId: string; newStart: string }
  | { type: 'add_lesson'; start: string; durationMin: number }
  | { type: 'payment'; lessons: number; amount: number | null }
  | { type: 'set_balance'; remaining: number }
  | { type: 'pause'; from: string; to: string }
  | { type: 'undo' };

export interface Reply {
  text: string;
  keyboard?: InlineKeyboard;
}

type ActionStatus = Extract<ResolvedAction, { type: 'status' }>['status'];

const STATUS_DESCRIPTION: Record<ActionStatus, string> = {
  done: 'было',
  cancelled: 'отменилось без списания',
  burned: 'отменилось, но сгорело',
  confirmed: 'в силе',
};

function fromLocal(value: string, zone: string): DateTime {
  return DateTime.fromISO(value, { zone });
}

/**
 * Превращает намерение в действие над конкретными записями.
 * Возвращает строку с объяснением, если выполнить нельзя.
 */
export function resolveIntent(
  intent: Intent,
  ctx: { now: DateTime; zone: string; open: Lesson[]; refs: LessonRef[]; defaultDuration: number },
): ResolvedAction | string | null {
  const byRef = (ref: string | null): Lesson | undefined =>
    ref ? ctx.refs.find((r) => r.ref === ref)?.lesson : undefined;

  switch (intent.type) {
    case 'lesson_status': {
      const lesson =
        byRef(intent.lesson_ref) ??
        svc.pickDefaultLesson(intent.status === 'confirmed' ? 'confirm' : 'resolve', ctx.open, ctx.now, ctx.zone);
      if (!lesson) return 'Не нашёл занятия, к которому это относится. Посмотри /status.';
      return { type: 'status', lessonId: lesson.id, status: intent.status };
    }
    case 'reschedule': {
      const lesson = byRef(intent.lesson_ref) ?? svc.pickDefaultLesson('reschedule', ctx.open, ctx.now, ctx.zone);
      if (!lesson) return 'Не нашёл занятия, которое можно перенести.';
      const newStart = fromLocal(intent.new_datetime, ctx.zone);
      if (!newStart.isValid) return 'Не понял новое время.';
      return { type: 'reschedule', lessonId: lesson.id, newStart: newStart.toISO() as string };
    }
    case 'add_lesson': {
      const start = fromLocal(intent.datetime, ctx.zone);
      if (!start.isValid) return 'Не понял дату и время.';
      return {
        type: 'add_lesson',
        start: start.toISO() as string,
        durationMin: intent.duration_min ?? ctx.defaultDuration,
      };
    }
    case 'payment':
      return { type: 'payment', lessons: intent.lessons, amount: intent.amount };
    case 'set_balance':
      return { type: 'set_balance', remaining: intent.remaining };
    case 'pause': {
      if (intent.to < intent.from) return 'Конец паузы раньше начала — проверь даты.';
      return { type: 'pause', from: intent.from, to: intent.to };
    }
    case 'undo':
      return { type: 'undo' };
    default:
      return null;
  }
}

/** Текст «понял так: …» для подтверждения. */
export async function describeAction(action: ResolvedAction): Promise<string> {
  const zone = config().TIME_ZONE;
  switch (action.type) {
    case 'status': {
      const lesson = await repo.getLesson(action.lessonId);
      const when = lesson ? fmtShort(lessonStart(lesson, zone)) : 'занятие';
      return `Занятие ${when}: ${STATUS_DESCRIPTION[action.status]}`;
    }
    case 'reschedule': {
      const lesson = await repo.getLesson(action.lessonId);
      const from = lesson ? fmtShort(lessonStart(lesson, zone)) : 'занятие';
      return `Перенести ${from} → ${fmtShort(DateTime.fromISO(action.newStart).setZone(zone))}`;
    }
    case 'add_lesson':
      return `Добавить занятие ${fmtShort(DateTime.fromISO(action.start).setZone(zone))}, ${action.durationMin} мин`;
    case 'payment':
      return `Записать оплату: +${lessonsWord(action.lessons)}${action.amount ? `, ${action.amount} ₽` : ''}`;
    case 'set_balance':
      return `Установить остаток оплаченных: ${lessonsWord(action.remaining)}`;
    case 'pause':
      return `Пауза с ${action.from} по ${action.to}: занятия в эти дни отменятся без списания`;
    case 'undo': {
      const last = await repo.getLastActionLog();
      return last ? `Отменить последнее действие: ${last.summary}` : 'Отменять нечего';
    }
  }
}

/** Клавиатура «отменить» и, если пора, «оплатил». */
function afterActionKeyboard(logId: number, showPay: boolean): InlineKeyboard {
  const kb = new InlineKeyboard().text('↩️ Отменить', cb.undo(logId));
  if (showPay) {
    const pack = config().PACK_SIZE;
    kb.row().text(`💳 Оплатил ${pack}`, cb.pay(pack)).text('⏰ Завтра', cb.paySnooze());
  }
  return kb;
}

/** Строка о балансе после действия и признак, что пора платить. */
async function balanceTail(): Promise<{ line: string; needPay: boolean }> {
  const cfg = config();
  const snap = await svc.loadSnapshot();
  const b = snap.balance;
  const needPay = b.upcoming.length > 0 && b.paidAhead <= cfg.PAY_REMIND_THRESHOLD;
  let line: string;
  if (b.remaining < 0) line = `⚠️ Не оплачено: ${lessonsWord(-b.remaining)}.`;
  else line = `💰 Осталось оплаченных: ${b.remaining}.`;
  if (needPay) line += b.paidAhead <= 0 ? ' Пора оплатить следующий пакет.' : ' Скоро нужно будет оплатить.';
  return { line, needPay };
}

export async function performAction(action: ResolvedAction): Promise<Reply> {
  const cfg = config();
  const zone = cfg.TIME_ZONE;

  switch (action.type) {
    case 'status': {
      const lesson = await repo.getLesson(action.lessonId);
      if (!lesson) return { text: 'Это занятие уже удалено.' };
      if (lesson.status === action.status) {
        return { text: `Занятие ${fmtShort(lessonStart(lesson, zone))} уже отмечено так.` };
      }
      const res = await svc.setLessonStatus(lesson, action.status);
      const chargeChanged = isCharged(action.status) !== isCharged(lesson.status);
      if (!chargeChanged) return { text: `Готово: ${res.summary}.`, keyboard: afterActionKeyboard(res.logId, false) };
      const tail = await balanceTail();
      return {
        text: `Готово: ${res.summary}.\n${tail.line}`,
        keyboard: afterActionKeyboard(res.logId, tail.needPay && isCharged(action.status)),
      };
    }
    case 'reschedule': {
      const lesson = await repo.getLesson(action.lessonId);
      if (!lesson) return { text: 'Это занятие уже удалено.' };
      if (lesson.status !== 'planned' && lesson.status !== 'confirmed') {
        return { text: 'Это занятие уже закрыто, перенести его нельзя. Можно добавить новое: /add' };
      }
      const res = await svc.rescheduleLesson(lesson, DateTime.fromISO(action.newStart).setZone(zone));
      return { text: `Готово: ${res.summary}.`, keyboard: afterActionKeyboard(res.logId, false) };
    }
    case 'add_lesson': {
      const res = await svc.addLesson(DateTime.fromISO(action.start).setZone(zone), action.durationMin);
      return { text: `Готово: ${res.summary}.`, keyboard: afterActionKeyboard(res.logId, false) };
    }
    case 'payment': {
      const res = await svc.addPayment(action.lessons, action.amount);
      if (!action.amount) {
        await repo.setState('await', { kind: 'amount', paymentId: res.payment.id }, 30);
      }
      const tail = await balanceTail();
      const hint = action.amount ? '' : '\nЕсли хочешь сохранить сумму — просто пришли её числом.';
      return {
        text: `💳 Записал: ${res.summary}.\n${tail.line}${hint}`,
        keyboard: afterActionKeyboard(res.logId, false),
      };
    }
    case 'set_balance': {
      const res = await svc.setBalance(action.remaining);
      if (!res) return { text: `Остаток и так ${lessonsWord(action.remaining)}.` };
      const tail = await balanceTail();
      return { text: `Готово: ${res.summary}.\n${tail.line}`, keyboard: afterActionKeyboard(res.logId, false) };
    }
    case 'pause': {
      const from = DateTime.fromISO(action.from, { zone });
      const to = DateTime.fromISO(action.to, { zone });
      const res = await svc.addPause(from, to);
      return { text: `⏸ Готово: ${res.summary}.`, keyboard: afterActionKeyboard(res.logId, false) };
    }
    case 'undo': {
      const res = await svc.undo();
      if (!res) return { text: 'Отменять нечего.' };
      const tail = await balanceTail();
      return { text: `↩️ Отменил: ${res.summary}.\n${tail.line}` };
    }
  }
}
