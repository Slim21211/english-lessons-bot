import { describe, expect, it } from 'vitest';
import {
  generateFromSchedule,
  parseScheduleArgs,
  parseSlotSpec,
  slotToSpec,
  specToSlot,
  staleGeneratedLessons,
} from '../src/domain/schedule.js';
import type { Slot } from '../src/domain/types.js';
import { pickDefaultLesson } from '../src/services/lessons.js';
import { buildMonthStats } from '../src/services/stats.js';
import { at, lesson, ZONE } from './helpers.js';

const slots: Slot[] = [
  { id: 1, weekday: 1, start_time: '16:40:00', duration_min: 60, active: true },
  { id: 2, weekday: 3, start_time: '16:40:00', duration_min: 60, active: true },
  { id: 3, weekday: 5, start_time: '10:00:00', duration_min: 60, active: false },
];

describe('generateFromSchedule', () => {
  it('создаёт пн и ср на горизонт вперёд', () => {
    const rows = generateFromSchedule(slots, [], at('2026-10-27T10:00'), 14, ZONE);
    expect(rows.map((r) => r.slot_key)).toEqual([
      '2026-10-28@16:40',
      '2026-11-02@16:40',
      '2026-11-04@16:40',
      '2026-11-09@16:40',
    ]);
    expect(rows[0]?.starts_at).toBe('2026-10-28T13:40:00.000Z');
  });

  it('не создаёт уже начавшееся сегодня и даты в паузе', () => {
    const rows = generateFromSchedule(
      slots,
      [{ id: 1, starts_on: '2026-11-02', ends_on: '2026-11-04', note: null }],
      at('2026-10-28T17:00'),
      14,
      ZONE,
    );
    expect(rows.map((r) => r.slot_key)).toEqual(['2026-11-09@16:40']);
  });
});

describe('parseScheduleArgs', () => {
  it('общее время для нескольких дней', () => {
    expect(parseScheduleArgs('пн ср 16:40', 60)).toEqual([
      { weekday: 1, hour: 16, minute: 40, duration_min: 60 },
      { weekday: 3, hour: 16, minute: 40, duration_min: 60 },
    ]);
  });

  it('разное время и длительность', () => {
    expect(parseScheduleArgs('пн 16:40, чт 18:00 90', 60)).toEqual([
      { weekday: 1, hour: 16, minute: 40, duration_min: 90 },
      { weekday: 4, hour: 18, minute: 0, duration_min: 90 },
    ]);
  });

  it('ошибки', () => {
    expect(parseScheduleArgs('16:40', 60)).toBeNull();
    expect(parseScheduleArgs('пн', 60)).toBeNull();
    expect(parseScheduleArgs('пн 25:00', 60)).toBeNull();
    expect(parseScheduleArgs('когда-нибудь', 60)).toBeNull();
  });
});

describe('pickDefaultLesson', () => {
  const past = lesson('2026-11-02T16:40');
  const today = lesson('2026-11-04T16:40');
  const next = lesson('2026-11-09T16:40');
  const open = [next, today, past];

  it('«было» относится к последнему начавшемуся', () => {
    expect(pickDefaultLesson('resolve', open, at('2026-11-04T18:00'), ZONE)?.id).toBe(today.id);
    expect(pickDefaultLesson('resolve', open, at('2026-11-03T12:00'), ZONE)?.id).toBe(past.id);
  });

  it('«отменили» утром без прошлых неотмеченных — сегодняшнее', () => {
    expect(pickDefaultLesson('resolve', [today, next], at('2026-11-04T09:00'), ZONE)?.id).toBe(today.id);
  });

  it('перенос — ближайшее незакончившееся', () => {
    expect(pickDefaultLesson('reschedule', open, at('2026-11-04T09:00'), ZONE)?.id).toBe(today.id);
    expect(pickDefaultLesson('reschedule', open, at('2026-11-04T18:00'), ZONE)?.id).toBe(next.id);
  });
});

describe('buildMonthStats', () => {
  it('группирует по месяцам и считает среднюю цену только по оплатам с суммой', () => {
    const stats = buildMonthStats(
      [lesson('2026-10-05T16:40', 'done'), lesson('2026-10-07T16:40', 'burned'), lesson('2026-11-02T16:40', 'done')],
      [
        { id: 'a', paid_at: '2026-10-01T09:00:00Z', lessons: 4, amount: 8000, kind: 'payment', note: null },
        { id: 'b', paid_at: '2026-10-20T09:00:00Z', lessons: 4, amount: null, kind: 'payment', note: null },
        { id: 'c', paid_at: '2026-10-01T09:00:00Z', lessons: 3, amount: null, kind: 'adjustment', note: null },
      ],
      ZONE,
    );
    expect(stats.map((s) => s.month)).toEqual(['ноябрь 2026', 'октябрь 2026']);
    expect(stats[1]).toMatchObject({ done: 1, burned: 1, bought: 8, spent: 8000, priced: 4 });
  });
});

describe('изменение расписания по слотам', () => {
  const slot = (id: number, weekday: number, time: string, duration = 60): Slot => ({
    id,
    weekday,
    start_time: `${time}:00`,
    duration_min: duration,
    active: true,
  });

  it('parseSlotSpec: ровно одно занятие', () => {
    expect(parseSlotSpec('вт 18:00 90', 60)).toEqual({ weekday: 2, hour: 18, minute: 0, duration_min: 90 });
    expect(parseSlotSpec('пн 16:40', 60)).toEqual({ weekday: 1, hour: 16, minute: 40, duration_min: 60 });
    expect(parseSlotSpec('пн ср 16:40', 60)).toBeNull();
    expect(parseSlotSpec('завтра', 60)).toBeNull();
  });

  it('slotToSpec и specToSlot — туда и обратно', () => {
    const s = slot(1, 3, '16:40', 45);
    expect(specToSlot(slotToSpec(s))).toEqual({ weekday: 3, start_time: '16:40:00', duration_min: 45 });
  });

  it('перенос пн → вт удаляет только понедельничные занятия', () => {
    const now = at('2026-10-27T10:00');
    const before = generateFromSchedule([slot(1, 1, '16:40'), slot(2, 3, '16:40')], [], now, 14, ZONE);
    const after = generateFromSchedule([slot(3, 2, '16:40'), slot(4, 3, '16:40')], [], now, 14, ZONE);
    const stale = staleGeneratedLessons(before, after);
    expect(stale.map((l) => l.slot_key)).toEqual(['2026-11-02@16:40', '2026-11-09@16:40']);
  });

  it('смена длительности пересоздаёт занятия этого слота', () => {
    const now = at('2026-10-27T10:00');
    const before = generateFromSchedule([slot(1, 3, '16:40', 60)], [], now, 7, ZONE);
    const after = generateFromSchedule([slot(2, 3, '16:40', 90)], [], now, 7, ZONE);
    expect(staleGeneratedLessons(before, after)).toHaveLength(1);
    expect(staleGeneratedLessons(before, before)).toEqual([]);
  });
});
