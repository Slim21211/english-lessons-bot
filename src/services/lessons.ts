import type { DateTime } from 'luxon';
import { config } from '../config.js';
import * as repo from '../db.js';
import { type Balance, computeBalance } from '../domain/balance.js';
import { generateFromSchedule, type SlotSpec } from '../domain/schedule.js';
import type { Entity, Lesson, LessonStatus, LoggedOp, Pause, Payment } from '../domain/types.js';
import { fmtShort, lessonEnd, lessonStart, lessonsWord, nowIn } from '../time.js';

const STRIP_ON_RESTORE = new Set(['id', 'created_at', 'updated_at']);

export interface Snapshot {
  now: DateTime;
  zone: string;
  balance: Balance;
  /** Занятия в окне −7 … +21 день (все статусы). */
  nearby: Lesson[];
}

export async function loadSnapshot(now = nowIn(config().TIME_ZONE)): Promise<Snapshot> {
  const zone = config().TIME_ZONE;
  const [totals, open, nearby] = await Promise.all([
    repo.getBalanceTotals(),
    repo.getOpenLessons(),
    repo.getLessonsBetween(
      now.minus({ days: 7 }).toUTC().toISO() as string,
      now.plus({ days: 21 }).toUTC().toISO() as string,
    ),
  ]);
  const balance = computeBalance({ ...totals, lessons: open, now, zone });
  return { now, zone, balance, nearby };
}

/** Создаёт занятия из расписания на горизонт вперёд. Безопасно вызывать сколько угодно раз. */
export async function materializeSchedule(now: DateTime): Promise<number> {
  const cfg = config();
  const [slots, pauses] = await Promise.all([repo.getActiveSlots(), repo.getPauses(now.toISODate() as string)]);
  const rows = generateFromSchedule(slots, pauses, now, cfg.HORIZON_DAYS, cfg.TIME_ZONE);
  return repo.insertGeneratedLessons(rows);
}

/**
 * Какое занятие пользователь имеет в виду, если не уточнил.
 * - «было / не было / сгорело»: последнее уже начавшееся неотмеченное; иначе сегодняшнее; иначе ближайшее.
 * - «в силе» и перенос: сегодняшнее незакончившееся, иначе ближайшее будущее.
 */
export function pickDefaultLesson(
  intent: 'resolve' | 'confirm' | 'reschedule',
  open: Lesson[],
  now: DateTime,
  zone: string,
): Lesson | null {
  const sorted = [...open].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const started = sorted.filter((l) => lessonStart(l, zone) <= now);
  const notEnded = sorted.filter((l) => lessonEnd(l, zone) > now);
  if (intent === 'resolve') {
    return started.at(-1) ?? notEnded.find((l) => lessonStart(l, zone).hasSame(now, 'day')) ?? notEnded[0] ?? null;
  }
  return notEnded[0] ?? null;
}

function op(entity: Entity, id: string, before: object | null, after: object | null): LoggedOp {
  return {
    entity,
    id,
    before: before as Record<string, unknown> | null,
    after: after as Record<string, unknown> | null,
  };
}

export interface ActionResult {
  logId: number;
  summary: string;
}

const STATUS_SUMMARY: Record<LessonStatus, string> = {
  planned: 'вернул в запланированные',
  confirmed: 'подтверждено',
  done: 'отмечено как состоявшееся',
  cancelled: 'отменено без списания',
  burned: 'отменено со списанием',
  rescheduled: 'перенесено',
};

export async function setLessonStatus(lesson: Lesson, status: LessonStatus, note?: string): Promise<ActionResult> {
  const zone = config().TIME_ZONE;
  const resolved = status !== 'planned' && status !== 'confirmed';
  const after = await repo.updateRow<Lesson>('lessons', lesson.id, {
    status,
    resolved_at: resolved ? new Date().toISOString() : null,
    ...(note !== undefined ? { note } : {}),
  });
  const summary = `${fmtShort(lessonStart(lesson, zone))}: ${STATUS_SUMMARY[status]}`;
  const logId = await repo.logAction(`lesson_${status}`, summary, [op('lessons', lesson.id, lesson, after)]);
  return { logId, summary };
}

export async function rescheduleLesson(
  lesson: Lesson,
  newStart: DateTime,
): Promise<ActionResult & { newLesson: Lesson }> {
  const zone = config().TIME_ZONE;
  const oldAfter = await repo.updateRow<Lesson>('lessons', lesson.id, {
    status: 'rescheduled',
    resolved_at: new Date().toISOString(),
  });
  const newLesson = await repo.insertRow<Lesson>('lessons', {
    starts_at: newStart.toUTC().toISO(),
    duration_min: lesson.duration_min,
    status: 'planned',
    rescheduled_from: lesson.id,
    note: lesson.note,
  });
  const summary = `перенос ${fmtShort(lessonStart(lesson, zone))} → ${fmtShort(newStart.setZone(zone))}`;
  const logId = await repo.logAction('reschedule', summary, [
    op('lessons', lesson.id, lesson, oldAfter),
    op('lessons', newLesson.id, null, newLesson),
  ]);
  return { logId, summary, newLesson };
}

export async function addLesson(
  start: DateTime,
  durationMin: number,
  note?: string,
): Promise<ActionResult & { lesson: Lesson }> {
  const zone = config().TIME_ZONE;
  const lesson = await repo.insertRow<Lesson>('lessons', {
    starts_at: start.toUTC().toISO(),
    duration_min: durationMin,
    status: 'planned',
    note: note ?? null,
  });
  const summary = `добавлено занятие ${fmtShort(start.setZone(zone))}`;
  const logId = await repo.logAction('add_lesson', summary, [op('lessons', lesson.id, null, lesson)]);
  return { logId, summary, lesson };
}

export async function addPayment(
  lessons: number,
  amount: number | null,
  kind: Payment['kind'] = 'payment',
  note?: string,
): Promise<ActionResult & { payment: Payment }> {
  const payment = await repo.insertRow<Payment>('payments', {
    lessons,
    amount,
    kind,
    note: note ?? null,
  });
  const summary =
    kind === 'adjustment'
      ? `корректировка баланса: ${lessons > 0 ? '+' : ''}${lessons}`
      : `оплата: +${lessonsWord(lessons)}${amount ? `, ${amount} ₽` : ''}`;
  const logId = await repo.logAction(kind, summary, [op('payments', payment.id, null, payment)]);
  return { logId, summary, payment };
}

/** Делает так, чтобы оплаченных-неиспользованных стало ровно target. */
export async function setBalance(target: number): Promise<ActionResult | null> {
  const totals = await repo.getBalanceTotals();
  const delta = target - (totals.credits - totals.used);
  if (delta === 0) return null;
  return addPayment(delta, null, 'adjustment', `баланс установлен в ${target}`);
}

export async function addPause(
  from: DateTime,
  to: DateTime,
  note?: string,
): Promise<ActionResult & { cancelled: number }> {
  const zone = config().TIME_ZONE;
  const pause = await repo.insertRow<Pause & { id: number }>('pauses', {
    starts_on: from.toISODate(),
    ends_on: to.toISODate(),
    note: note ?? null,
  });
  const ops: LoggedOp[] = [op('pauses', String(pause.id), null, pause)];
  const inRange = await repo.getLessonsBetween(
    from.setZone(zone).startOf('day').toUTC().toISO() as string,
    to.setZone(zone).endOf('day').toUTC().toISO() as string,
  );
  let cancelled = 0;
  for (const lesson of inRange.filter((l) => l.status === 'planned' || l.status === 'confirmed')) {
    const after = await repo.updateRow<Lesson>('lessons', lesson.id, {
      status: 'cancelled',
      resolved_at: new Date().toISOString(),
      note: 'пауза',
    });
    ops.push(op('lessons', lesson.id, lesson, after));
    cancelled++;
  }
  const summary = `пауза ${from.toFormat('dd.MM')}–${to.toFormat('dd.MM')}${cancelled ? `, отменено: ${cancelled}` : ''}`;
  const logId = await repo.logAction('pause', summary, ops);
  return { logId, summary, cancelled };
}

/**
 * Откатывает действие из журнала: операции в обратном порядке.
 * Без id — последнее неотменённое.
 */
export async function undo(logId?: number): Promise<{ summary: string } | null> {
  const entry = logId ? await repo.getActionLog(logId) : await repo.getLastActionLog();
  if (!entry || entry.undone_at) return null;
  for (const item of [...entry.ops].reverse()) {
    if (item.before === null) {
      await repo.deleteRow(item.entity, item.id);
    } else if (item.after === null) {
      await repo.insertRow(item.entity, item.before);
    } else {
      const patch = Object.fromEntries(Object.entries(item.before).filter(([k]) => !STRIP_ON_RESTORE.has(k)));
      await repo.updateRow(item.entity, item.id, patch);
    }
  }
  await repo.markActionUndone(entry.id);
  return { summary: entry.summary };
}

/**
 * Новое регулярное расписание: старые слоты выключаются, будущие незатронутые
 * занятия из старого расписания удаляются и создаются заново по новому.
 */
export async function applySchedule(specs: SlotSpec[], now: DateTime): Promise<{ removed: number; created: number }> {
  await repo.replaceSlots(
    specs.map((s) => ({
      weekday: s.weekday,
      start_time: `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}:00`,
      duration_min: s.duration_min,
    })),
  );
  const removed = await repo.deleteFutureGeneratedLessons(now.toUTC().toISO() as string);
  const created = await materializeSchedule(now);
  return { removed, created };
}
