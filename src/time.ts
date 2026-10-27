import { DateTime } from 'luxon';
import type { Lesson } from './domain/types.js';

export const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const;
export const WEEKDAYS_FULL = [
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье',
] as const;
const MONTHS_GEN = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

export function nowIn(zone: string): DateTime {
  return DateTime.now().setZone(zone);
}

export function toZone(iso: string, zone: string): DateTime {
  return DateTime.fromISO(iso, { setZone: true }).setZone(zone);
}

export function lessonStart(lesson: Pick<Lesson, 'starts_at'>, zone: string): DateTime {
  return toZone(lesson.starts_at, zone);
}

export function lessonEnd(lesson: Pick<Lesson, 'starts_at' | 'duration_min'>, zone: string): DateTime {
  return lessonStart(lesson, zone).plus({ minutes: lesson.duration_min });
}

/** «пн 02.11 16:40» */
export function fmtShort(dt: DateTime): string {
  return `${WEEKDAYS_SHORT[dt.weekday - 1]} ${dt.toFormat('dd.MM HH:mm')}`;
}

/** «понедельник, 2 ноября, 16:40» */
export function fmtLong(dt: DateTime): string {
  return `${WEEKDAYS_FULL[dt.weekday - 1]}, ${dt.day} ${MONTHS_GEN[dt.month - 1]}, ${dt.toFormat('HH:mm')}`;
}

/** «2 ноября» */
export function fmtDay(dt: DateTime): string {
  return `${dt.day} ${MONTHS_GEN[dt.month - 1]}`;
}

/** «сегодня», «завтра», «вчера» или «пн 02.11» */
export function fmtRelativeDay(dt: DateTime, now: DateTime): string {
  const diff = Math.round(dt.startOf('day').diff(now.startOf('day'), 'days').days);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === -1) return 'вчера';
  return `${WEEKDAYS_SHORT[dt.weekday - 1]} ${dt.toFormat('dd.MM')}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

export const lessonsWord = (n: number): string => `${n} ${plural(n, 'занятие', 'занятия', 'занятий')}`;

export function fmtMoney(amount: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount)} ₽`;
}
