import type { DateTime } from 'luxon';
import type { Pause, Slot } from './types.js';

export interface GeneratedLesson {
  slot_key: string;
  starts_at: string;
  duration_min: number;
}

export function slotTime(slot: Pick<Slot, 'start_time'>): { hour: number; minute: number } {
  const [h = '0', m = '0'] = slot.start_time.split(':');
  return { hour: Number(h), minute: Number(m) };
}

export function isPaused(date: DateTime, pauses: Pause[]): boolean {
  const day = date.toISODate();
  if (!day) return false;
  return pauses.some((p) => p.starts_on <= day && day <= p.ends_on);
}

/**
 * Занятия из регулярного расписания на horizonDays вперёд, начиная с now.
 * Прошедшие и попадающие в паузы не создаются. Повторная генерация безопасна:
 * в БД стоит уникальный slot_key.
 */
export function generateFromSchedule(
  slots: Slot[],
  pauses: Pause[],
  now: DateTime,
  horizonDays: number,
  zone: string,
): GeneratedLesson[] {
  const result: GeneratedLesson[] = [];
  const start = now.setZone(zone).startOf('day');
  for (let i = 0; i < horizonDays; i++) {
    const day = start.plus({ days: i });
    if (isPaused(day, pauses)) continue;
    for (const slot of slots) {
      if (!slot.active || slot.weekday !== day.weekday) continue;
      const { hour, minute } = slotTime(slot);
      const startsAt = day.set({ hour, minute, second: 0, millisecond: 0 });
      if (startsAt <= now) continue;
      result.push({
        slot_key: slotKey(startsAt),
        starts_at: startsAt.toUTC().toISO() as string,
        duration_min: slot.duration_min,
      });
    }
  }
  return result.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

export function slotKey(startsAt: DateTime): string {
  return `${startsAt.toISODate()}@${startsAt.toFormat('HH:mm')}`;
}

export interface SlotSpec {
  weekday: number;
  hour: number;
  minute: number;
  duration_min: number;
}

const WEEKDAY_TOKENS: Record<string, number> = {
  пн: 1,
  пон: 1,
  понедельник: 1,
  вт: 2,
  вторник: 2,
  ср: 3,
  среда: 3,
  чт: 4,
  четверг: 4,
  пт: 5,
  пятница: 5,
  сб: 6,
  суббота: 6,
  вс: 7,
  воскресенье: 7,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
};

/**
 * Разбор аргументов /schedule: «пн ср 16:40», «пн 16:40 ср 18:00 90».
 * Дни копятся, пока не встретится время; число без двоеточия в конце — длительность.
 */
export function parseScheduleArgs(input: string, defaultDuration: number): SlotSpec[] | null {
  const tokens = input.toLowerCase().replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let duration = defaultDuration;
  const last = tokens.at(-1);
  if (last && /^\d{2,3}$/.test(last)) {
    duration = Number(last);
    tokens.pop();
  }
  if (duration < 10 || duration > 600) return null;

  const specs: SlotSpec[] = [];
  let pendingDays: number[] = [];
  for (const token of tokens) {
    const day = WEEKDAY_TOKENS[token.replace(/\.$/, '')];
    if (day) {
      pendingDays.push(day);
      continue;
    }
    const time = /^(\d{1,2})[:.](\d{2})$/.exec(token);
    if (time) {
      const hour = Number(time[1]);
      const minute = Number(time[2]);
      if (hour > 23 || minute > 59 || pendingDays.length === 0) return null;
      for (const weekday of pendingDays) specs.push({ weekday, hour, minute, duration_min: duration });
      pendingDays = [];
      continue;
    }
    return null;
  }
  if (pendingDays.length > 0 || specs.length === 0) return null;

  const unique = new Map(specs.map((s) => [`${s.weekday}@${s.hour}:${s.minute}`, s]));
  return [...unique.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour || a.minute - b.minute);
}
