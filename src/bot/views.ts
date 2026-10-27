import { InlineKeyboard } from 'grammy';
import type { DateTime } from 'luxon';
import type { Balance } from '../domain/balance.js';
import { slotTime } from '../domain/schedule.js';
import type { Lesson, Pause, Payment, Slot } from '../domain/types.js';
import { fmtLong, fmtMoney, fmtRelativeDay, fmtShort, lessonStart, lessonsWord, WEEKDAYS_SHORT } from '../time.js';

// ---------- Callback data ----------
// Лимит Telegram — 64 байта; uuid занимает 36.

export const cb = {
  status: (status: 'done' | 'cancelled' | 'burned' | 'confirmed', id: string) => `ls:${status}:${id}`,
  reschedule: (id: string) => `lr:${id}`,
  homework: (id: string) => `hw:${id}`,
  pay: (lessons: number) => `pay:${lessons}`,
  paySnooze: () => 'pay:snooze',
  undo: (logId: number) => `undo:${logId}`,
  slotsCount: (n: number) => `sch:n:${n}`,
  slotsNew: () => 'sch:new',
  slotAdd: () => 'sch:add',
  slotEdit: (id: number) => `sch:e:${id}`,
  slotDelete: (id: number) => `sch:d:${id}`,
  scheduleOk: () => 'sch:ok',
  scheduleNo: () => 'sch:no',
  intentOk: (token: string) => `int:ok:${token}`,
  intentNo: (token: string) => `int:no:${token}`,
};

// ---------- Клавиатуры ----------

export function morningKeyboard(lesson: Lesson): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ В силе', cb.status('confirmed', lesson.id))
    .text('🔁 Перенос', cb.reschedule(lesson.id))
    .row()
    .text('❌ Отменилось', cb.status('cancelled', lesson.id))
    .text('🔥 Отмена, сгорело', cb.status('burned', lesson.id));
}

export function homeworkKeyboard(lesson: Lesson): InlineKeyboard {
  return new InlineKeyboard().text('✅ ДЗ сделано', cb.homework(lesson.id));
}

export function postKeyboard(lesson: Lesson): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Было', cb.status('done', lesson.id))
    .text('❌ Не было', cb.status('cancelled', lesson.id))
    .row()
    .text('🔥 Не было, но сгорело', cb.status('burned', lesson.id))
    .row()
    .text('🔁 Перенесли', cb.reschedule(lesson.id));
}

export function paymentKeyboard(packSize: number): InlineKeyboard {
  return new InlineKeyboard().text(`💳 Оплатил ${packSize}`, cb.pay(packSize)).text('⏰ Завтра', cb.paySnooze());
}

/** «пн 16:40» */
export function slotTimeLabel(slot: Pick<Slot, 'weekday' | 'start_time'>): string {
  const { hour, minute } = slotTime(slot);
  return `${WEEKDAYS_SHORT[slot.weekday - 1]} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** «каждый пн 16:40, 60 мин» — слово «каждый» подчёркивает, что это регулярное расписание, а не одно занятие. */
export function slotLabel(slot: Pick<Slot, 'weekday' | 'start_time' | 'duration_min'>): string {
  return `каждый ${slotTimeLabel(slot)}, ${slot.duration_min} мин`;
}

export function slotsCountKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let n = 1; n <= 5; n++) kb.text(String(n), cb.slotsCount(n));
  return kb;
}

export function scheduleKeyboard(slots: Slot[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const slot of slots) {
    kb.text(`✏️ Каждый ${slotTimeLabel(slot)}`, cb.slotEdit(slot.id))
      .text('🗑', cb.slotDelete(slot.id))
      .row();
  }
  kb.text('➕ Добавить в расписание', cb.slotAdd());
  if (slots.length > 0) kb.row().text('🔄 Задать расписание заново', cb.slotsNew());
  return kb;
}

export function slotPrompt(index: number, total: number, defaultDuration: number): string {
  const head = total > 1 ? `Занятие ${index} из ${total}` : 'Занятие';
  return `${head}: день недели и время, например «пн 16:40». Если длится не ${defaultDuration} мин — добавь минуты в конце: «вт 18:00 90». /cancel — отмена.`;
}

export function scheduleConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('✅ Да, изменить расписание', cb.scheduleOk()).text('✖️ Нет', cb.scheduleNo());
}

export const ONE_OFF_HINT =
  'Если нужно перенести или отменить только одно занятие — расписание не трогай: нажми «🔁 Перенос» или «❌ Отменилось» в напоминании, либо напиши «перенесли пн на вт 16:40» / «9.11 отменяется».';

/** Подтверждение изменения регулярного расписания: что именно поменяется в будущих занятиях. */
export function scheduleChangeText(change: string, removed: Lesson[], addedCount: number, zone: string): string {
  const dates =
    removed
      .slice(0, 5)
      .map((l) => lessonStart(l, zone).toFormat('dd.MM'))
      .join(', ') + (removed.length > 5 ? ', …' : '');
  const lines = ['🗓 Меняю РЕГУЛЯРНОЕ расписание — для всех будущих недель, а не одно занятие:', change, ''];
  if (removed.length > 0) lines.push(`Уберу будущих занятий: ${removed.length} (${dates}).`);
  if (addedCount > 0) lines.push(`Создам занятий: ${addedCount}.`);
  if (removed.length === 0 && addedCount === 0) lines.push('Будущие занятия не изменятся.');
  lines.push('', ONE_OFF_HINT, '', 'Изменить расписание?');
  return lines.join('\n');
}

export function undoKeyboard(logId: number): InlineKeyboard {
  return new InlineKeyboard().text('↩️ Отменить', cb.undo(logId));
}

export function confirmKeyboard(token: string): InlineKeyboard {
  return new InlineKeyboard().text('✅ Да', cb.intentOk(token)).text('✖️ Нет', cb.intentNo(token));
}

// ---------- Тексты ----------

export function balanceLine(balance: Balance): string {
  if (balance.remaining < 0) {
    return `⚠️ Долг: ${lessonsWord(-balance.remaining)} не оплачено.`;
  }
  return `💰 Оплачено и не использовано: ${lessonsWord(balance.remaining)}.`;
}

export function paidAheadLine(balance: Balance, zone: string, now: DateTime): string {
  if (balance.paidUntil) {
    const until = lessonStart(balance.paidUntil, zone);
    const next = balance.firstUnpaid
      ? ` Следующее, ${fmtRelativeDay(lessonStart(balance.firstUnpaid, zone), now)}, уже не оплачено.`
      : '';
    return `Хватит до ${fmtShort(until)} включительно.${next}`;
  }
  if (balance.firstUnpaid) {
    return `Ближайшее занятие, ${fmtRelativeDay(lessonStart(balance.firstUnpaid, zone), now)}, не оплачено.`;
  }
  return '';
}

export function statusText(balance: Balance, zone: string, now: DateTime, limit = 6): string {
  const lines: string[] = [balanceLine(balance)];
  const ahead = paidAheadLine(balance, zone, now);
  if (ahead) lines.push(ahead);

  if (balance.pendingPast.length > 0) {
    lines.push('', '❓ Не отмечены:');
    for (const l of balance.pendingPast) lines.push(`• ${fmtShort(lessonStart(l, zone))}`);
  }

  const upcoming = balance.coverage.slice(balance.pendingPast.length, balance.pendingPast.length + limit);
  if (upcoming.length > 0) {
    lines.push('', '📅 Ближайшие:');
    for (const { lesson, paid } of upcoming) {
      const mark = paid ? '✅' : '⚠️';
      const confirmed = lesson.status === 'confirmed' ? ' (подтверждено)' : '';
      const homework = lesson.homework_done_at ? ' 📚' : '';
      lines.push(`${mark} ${fmtShort(lessonStart(lesson, zone))}${confirmed}${homework}`);
    }
    lines.push('', '✅ — оплачено, ⚠️ — нужна оплата, 📚 — ДЗ сделано');
  } else {
    lines.push('', 'Запланированных занятий нет.');
  }
  return lines.join('\n');
}

export function morningText(lesson: Lesson, zone: string): string {
  return `☀️ Сегодня в ${lessonStart(lesson, zone).toFormat('HH:mm')} английский. В силе?`;
}

export function homeworkText(lesson: Lesson, zone: string, now: DateTime): string {
  const start = lessonStart(lesson, zone);
  const hours = start.diff(now, 'hours').hours;
  const when =
    hours <= 3
      ? `через ${hours < 1 ? `${Math.max(1, Math.round(hours * 60))} мин` : `${Math.round(hours)} ч`}`
      : `${fmtRelativeDay(start, now)} в ${start.toFormat('HH:mm')}`;
  return `📚 Английский ${when}. ДЗ сделано?`;
}

export function postText(lesson: Lesson, zone: string, nag: boolean): string {
  const when = fmtLong(lessonStart(lesson, zone));
  return nag ? `Напоминаю: не отмечено занятие ${when}. Было?` : `📝 Занятие ${when} — было?`;
}

export function paymentText(balance: Balance, zone: string, now: DateTime): string {
  const head =
    balance.paidAhead <= 0
      ? '💳 Оплаченные занятия закончились.'
      : `💳 Осталось ${lessonsWord(balance.paidAhead)} оплаченных.`;
  const ahead = paidAheadLine(balance, zone, now);
  return [head, ahead, 'Не забудь оплатить следующий пакет.'].filter(Boolean).join('\n');
}

export function autoDoneText(lesson: Lesson, zone: string): string {
  return `🤖 Занятие ${fmtShort(lessonStart(lesson, zone))} никто не отметил — считаю, что оно было.`;
}

const STATUS_ICON: Record<Lesson['status'], string> = {
  planned: '🕒',
  confirmed: '🕒',
  done: '✅',
  cancelled: '❌',
  burned: '🔥',
  rescheduled: '🔁',
};

export function historyText(lessons: Lesson[], payments: Payment[], zone: string): string {
  const lines: string[] = ['🗂 Последние занятия:'];
  if (lessons.length === 0) lines.push('пока пусто');
  for (const l of lessons) {
    const note = l.note ? ` — ${l.note}` : '';
    lines.push(`${STATUS_ICON[l.status]} ${fmtShort(lessonStart(l, zone))}${note}`);
  }
  lines.push('', '💳 Оплаты:');
  if (payments.length === 0) lines.push('пока пусто');
  for (const p of payments) {
    const date = lessonStart({ starts_at: p.paid_at }, zone).toFormat('dd.MM.yy');
    const what =
      p.kind === 'adjustment' ? `корректировка ${p.lessons > 0 ? '+' : ''}${p.lessons}` : `+${lessonsWord(p.lessons)}`;
    lines.push(`• ${date}: ${what}${p.amount ? `, ${fmtMoney(p.amount)}` : ''}`);
  }
  lines.push('', '✅ было · ❌ отменено · 🔥 сгорело · 🔁 перенесено');
  return lines.join('\n');
}

export function scheduleText(slots: Slot[], pauses: Pause[]): string {
  const lines: string[] = ['🗓 Регулярное расписание (повторяется каждую неделю):'];
  if (slots.length === 0) lines.push('не задано');
  for (const s of slots) lines.push(`• ${slotLabel(s)}`);
  if (pauses.length > 0) {
    lines.push('', '⏸ Паузы:');
    for (const p of pauses) lines.push(`• ${p.starts_on} — ${p.ends_on}${p.note ? ` (${p.note})` : ''}`);
  }
  lines.push(
    '',
    'Кнопки ниже меняют расписание на все будущие недели. Перенести или отменить одно занятие — кнопками в напоминании или словами: «перенесли на чт 18:00», «9.11 отменяется».',
  );
  return lines.join('\n');
}

export interface MonthStats {
  month: string;
  done: number;
  burned: number;
  cancelled: number;
  bought: number;
  spent: number;
  /** Купленные занятия, у которых указана сумма — для средней цены. */
  priced: number;
}

export function statsText(stats: MonthStats[]): string {
  if (stats.length === 0) return 'Пока нет данных для статистики.';
  const lines = ['📊 Статистика по месяцам:'];
  let totalDone = 0;
  let totalSpent = 0;
  let totalPriced = 0;
  for (const s of stats) {
    totalDone += s.done;
    totalSpent += s.spent;
    totalPriced += s.priced;
    const parts = [`было ${s.done}`];
    if (s.burned) parts.push(`сгорело ${s.burned}`);
    if (s.cancelled) parts.push(`отменено ${s.cancelled}`);
    if (s.spent) parts.push(`оплачено ${fmtMoney(s.spent)}`);
    lines.push(`• ${s.month}: ${parts.join(', ')}`);
  }
  lines.push('', `Всего занятий: ${totalDone}.`);
  if (totalSpent > 0 && totalPriced > 0) {
    lines.push(
      `Потрачено: ${fmtMoney(totalSpent)}, в среднем ${fmtMoney(Math.round(totalSpent / totalPriced))} за занятие.`,
    );
  }
  return lines.join('\n');
}

export function weeklyText(week: Lesson[], balance: Balance, zone: string, now: DateTime): string {
  const done = week.filter((l) => l.status === 'done').length;
  const burned = week.filter((l) => l.status === 'burned').length;
  const cancelled = week.filter((l) => l.status === 'cancelled').length;
  const parts = [`было ${done}`];
  if (cancelled) parts.push(`отменено ${cancelled}`);
  if (burned) parts.push(`сгорело ${burned}`);
  const nextWeek = balance.coverage
    .slice(balance.pendingPast.length)
    .filter((c) => lessonStart(c.lesson, zone) < now.plus({ days: 8 }).startOf('day'));
  const lines = [`📆 Итоги недели: ${parts.join(', ')}.`, balanceLine(balance)];
  if (nextWeek.length > 0) {
    lines.push('', 'На следующей неделе:');
    for (const { lesson, paid } of nextWeek) lines.push(`${paid ? '✅' : '⚠️'} ${fmtShort(lessonStart(lesson, zone))}`);
  }
  if (balance.pendingPast.length > 0) {
    lines.push('', `Не отмечено занятий: ${balance.pendingPast.length} — /status`);
  }
  return lines.join('\n');
}

export const HELP_TEXT = [
  'Я слежу за занятиями английским: спрашиваю, были ли они, считаю оплаченные, напоминаю об оплате и о ДЗ.',
  '',
  'Команды:',
  '/status — сколько осталось и ближайшие занятия',
  '/paid [занятий] [сумма] — записать оплату (по умолчанию пакет)',
  '/setbalance N — выставить текущий остаток (для старта или сверки)',
  '/add <дата время> — разовое занятие, например /add 5.11 18:00',
  '/schedule — регулярное расписание: поменять день/время навсегда, добавить или убрать',
  '/pause <с> <по> — перерыв, например /pause 28.12 10.01',
  '/history — последние занятия и оплаты',
  '/stats — статистика по месяцам',
  '/hw — ДЗ к ближайшему занятию сделано (больше не напоминаю)',
  '/undo — отменить последнее действие',
  '',
  'Можно писать обычным текстом: «было», «дз сделано», «перенесли на пт в 18», «оплатил 4 занятия 8000», «в декабре с 28 по 10 января каникулы».',
].join('\n');
