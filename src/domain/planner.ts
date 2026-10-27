import type { DateTime } from 'luxon';
import { lessonEnd, lessonStart } from '../time.js';
import type { Balance } from './balance.js';
import { isOpen, type Lesson } from './types.js';

export interface PlannerSettings {
  morningHour: number;
  postLessonDelayMin: number;
  payRemindThreshold: number;
  payRemindHour: number;
  weeklyDigest: boolean;
  weeklyDigestHour: number;
  autoDoneAfterHours: number;
}

export interface PlannerInput {
  now: DateTime;
  zone: string;
  /** Занятия в окне «несколько дней назад … пару недель вперёд». */
  lessons: Lesson[];
  balance: Balance;
  /** Ключи уже отправленных уведомлений. */
  sent: ReadonlySet<string>;
  /** До какого момента отложено напоминание об оплате. */
  paySnoozedUntil: DateTime | null;
  settings: PlannerSettings;
}

export type Notice =
  | { kind: 'morning'; key: string; lesson: Lesson }
  | { kind: 'post'; key: string; lesson: Lesson }
  | { kind: 'post_nag'; key: string; lesson: Lesson }
  | { kind: 'auto_done'; key: string; lesson: Lesson }
  | { kind: 'payment'; key: string }
  | { kind: 'weekly'; key: string };

export const noticeKey = {
  morning: (id: string) => `morning:${id}`,
  post: (id: string) => `post:${id}`,
  postNag: (id: string) => `post_nag:${id}`,
  autoDone: (id: string) => `auto_done:${id}`,
  payment: (day: DateTime) => `payment:${day.toISODate()}`,
  weekly: (day: DateTime) => `weekly:${day.toFormat("kkkk-'W'WW")}`,
};

/**
 * Решает, какие уведомления нужно отправить прямо сейчас.
 * Чистая функция: никакого ввода-вывода, только расчёт — поэтому тик можно
 * вызывать сколько угодно раз, а ключи в notifications не дадут повторов.
 */
export function plan(input: PlannerInput): Notice[] {
  const { now, zone, lessons, balance, sent, paySnoozedUntil, settings } = input;
  const notices: Notice[] = [];
  const today = now.startOf('day');
  const morningToday = today.set({ hour: settings.morningHour });

  const open = lessons.filter((l) => isOpen(l.status)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  for (const lesson of open) {
    const start = lessonStart(lesson, zone);
    const end = lessonEnd(lesson, zone);

    // Утром в день занятия: «в силе?» — только если ещё не подтверждено и занятие позже утра.
    const morningKey = noticeKey.morning(lesson.id);
    if (
      lesson.status === 'planned' &&
      start.hasSame(now, 'day') &&
      now >= morningToday &&
      now < start &&
      start > morningToday &&
      !sent.has(morningKey)
    ) {
      notices.push({ kind: 'morning', key: morningKey, lesson });
    }

    // Автоотметка — до вопросов «было ли», чтобы не спрашивать о том, что уже закрыто.
    if (settings.autoDoneAfterHours > 0 && now >= end.plus({ hours: settings.autoDoneAfterHours })) {
      const key = noticeKey.autoDone(lesson.id);
      if (!sent.has(key)) notices.push({ kind: 'auto_done', key, lesson });
      continue;
    }

    // После занятия: «было?»
    const postDue = end.plus({ minutes: settings.postLessonDelayMin });
    const postKey = noticeKey.post(lesson.id);
    if (now >= postDue && !sent.has(postKey)) {
      notices.push({ kind: 'post', key: postKey, lesson });
      continue;
    }

    // На следующее утро, если ответа так и нет, — один повтор.
    const nagDue = end.plus({ days: 1 }).startOf('day').set({ hour: settings.morningHour });
    const nagKey = noticeKey.postNag(lesson.id);
    if (sent.has(postKey) && now >= nagDue && !sent.has(nagKey)) {
      notices.push({ kind: 'post_nag', key: nagKey, lesson });
    }
  }

  // Оплата: напоминаем раз в день, пока впереди мало оплаченных и есть занятия в ближайшие две недели.
  const payKey = noticeKey.payment(today);
  const soonLimit = now.plus({ days: 14 });
  const hasSoonLesson = balance.upcoming.some((l) => lessonStart(l, zone) <= soonLimit);
  if (
    hasSoonLesson &&
    balance.paidAhead <= settings.payRemindThreshold &&
    now >= today.set({ hour: settings.payRemindHour }) &&
    !(paySnoozedUntil && paySnoozedUntil > now) &&
    !sent.has(payKey)
  ) {
    notices.push({ kind: 'payment', key: payKey });
  }

  // Итоги недели в воскресенье вечером.
  const weeklyKey = noticeKey.weekly(today);
  if (
    settings.weeklyDigest &&
    now.weekday === 7 &&
    now >= today.set({ hour: settings.weeklyDigestHour }) &&
    !sent.has(weeklyKey)
  ) {
    notices.push({ kind: 'weekly', key: weeklyKey });
  }

  return notices;
}
