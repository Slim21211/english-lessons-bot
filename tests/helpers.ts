import { DateTime } from 'luxon';
import type { Lesson, LessonStatus } from '../src/domain/types.js';

export const ZONE = 'Europe/Moscow';

/** Местное время в Москве: at('2026-11-02T16:40') */
export const at = (local: string): DateTime => DateTime.fromISO(local, { zone: ZONE });

let seq = 0;
export function lesson(local: string, status: LessonStatus = 'planned', duration = 60): Lesson {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    starts_at: at(local).toUTC().toISO() as string,
    duration_min: duration,
    status,
    slot_key: null,
    rescheduled_from: null,
    note: null,
    resolved_at: null,
    homework_done_at: null,
  };
}
