import type { DateTime } from 'luxon';
import { lessonEnd } from '../time.js';
import { isOpen, type Lesson } from './types.js';

export interface Coverage {
  lesson: Lesson;
  paid: boolean;
}

export interface Balance {
  /** Всего куплено занятий (оплаты + корректировки). */
  credits: number;
  /** Списано: состоявшиеся и сгоревшие. */
  used: number;
  /** Оплачено и ещё не списано. Может быть отрицательным — долг. */
  remaining: number;
  /** Прошедшие, но не отмеченные занятия: скорее всего, тоже спишутся. */
  pendingPast: Lesson[];
  /** Будущие открытые занятия по возрастанию. */
  upcoming: Lesson[];
  /** Сколько оплаченных останется на будущие занятия после отметки прошедших. */
  paidAhead: number;
  /** Какие из неотмеченных и будущих занятий покрыты оплатой. */
  coverage: Coverage[];
  /** Последнее будущее занятие, которое ещё оплачено. */
  paidUntil: Lesson | null;
  /** Первое будущее занятие без оплаты. */
  firstUnpaid: Lesson | null;
}

export interface BalanceInput {
  credits: number;
  used: number;
  /** Открытые занятия (planned/confirmed) в любом порядке; остальные игнорируются. */
  lessons: Lesson[];
  now: DateTime;
  zone: string;
}

export function computeBalance({ credits, used, lessons, now, zone }: BalanceInput): Balance {
  const open = lessons.filter((l) => isOpen(l.status)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  // Прошедшим считаем занятие, которое уже закончилось.
  const pendingPast = open.filter((l) => lessonEnd(l, zone) <= now);
  const upcoming = open.filter((l) => lessonEnd(l, zone) > now);

  const remaining = credits - used;
  let left = remaining;
  const coverage: Coverage[] = [...pendingPast, ...upcoming].map((lesson) => {
    const paid = left > 0;
    left -= 1;
    return { lesson, paid };
  });

  const upcomingCoverage = coverage.slice(pendingPast.length);
  const paidUpcoming = upcomingCoverage.filter((c) => c.paid);

  return {
    credits,
    used,
    remaining,
    pendingPast,
    upcoming,
    paidAhead: remaining - pendingPast.length,
    coverage,
    paidUntil: paidUpcoming.at(-1)?.lesson ?? null,
    firstUnpaid: upcomingCoverage.find((c) => !c.paid)?.lesson ?? null,
  };
}
