import { describe, expect, it } from 'vitest';
import { extractDate, extractTime, parseDateTime } from '../src/nlu/datetime.js';
import { at } from './helpers.js';

// Вторник, 27 октября 2026, 10:00
const now = at('2026-10-27T10:00');
const fmt = (dt: ReturnType<typeof parseDateTime>) => dt?.toFormat("yyyy-MM-dd'T'HH:mm") ?? null;

describe('extractTime', () => {
  it.each([
    ['в 16:40', 16, 40],
    ['18:00', 18, 0],
    ['в 18.30', 18, 30],
    ['пятница 16.40', 16, 40],
    ['в 18', 18, 0],
    ['к 9 утра', 9, 0],
    ['в 7 вечера', 19, 0],
    ['в 3 часа дня', 15, 0],
  ])('%s', (text, hour, minute) => {
    expect(extractTime(text).time).toEqual({ hour, minute });
  });

  it('не путает «в 2 ноября» со временем', () => {
    expect(extractTime('в 2 ноября').time).toBeNull();
    expect(extractTime('2 ноября в 18').time).toEqual({ hour: 18, minute: 0 });
  });

  it('не считает дату 10.11 временем', () => {
    expect(extractTime('10.11').time).toBeNull();
  });
});

describe('extractDate', () => {
  it.each([
    ['сегодня', '2026-10-27'],
    ['завтра', '2026-10-28'],
    ['послезавтра', '2026-10-29'],
    ['пятница', '2026-10-30'],
    ['в пятницу', '2026-10-30'],
    ['вт', '2026-10-27'],
    ['в следующий вторник', '2026-11-03'],
    ['5.11', '2026-11-05'],
    ['05.11.2026', '2026-11-05'],
    ['2 ноября', '2026-11-02'],
    ['10 января', '2027-01-10'],
    ['20.10', '2027-10-20'],
  ])('%s → %s', (text, expected) => {
    expect(extractDate(text, now)?.toISODate()).toBe(expected);
  });

  it('с allowPast берёт прошедший день недели', () => {
    expect(extractDate('в понедельник', now, true)?.toISODate()).toBe('2026-10-26');
    expect(extractDate('20.10', now, true)?.toISODate()).toBe('2026-10-20');
  });
});

describe('parseDateTime', () => {
  it.each([
    ['пт 18:00', '2026-10-30T18:00'],
    ['завтра в 17', '2026-10-28T17:00'],
    ['5.11 16:40', '2026-11-05T16:40'],
    ['2 ноября в 18:30', '2026-11-02T18:30'],
    ['в 18', '2026-10-27T18:00'],
    ['в 9', '2026-10-28T09:00'],
  ])('%s → %s', (text, expected) => {
    expect(fmt(parseDateTime(text, now))).toBe(expected);
  });

  it('день недели без времени берёт время по умолчанию', () => {
    expect(fmt(parseDateTime('в четверг', now, { defaultTime: { hour: 16, minute: 40 } }))).toBe('2026-10-29T16:40');
  });

  it('сегодняшний день недели с прошедшим временем — на следующей неделе', () => {
    expect(fmt(parseDateTime('вт 9:00', now))).toBe('2026-11-03T09:00');
  });

  it('без времени и без значения по умолчанию — null', () => {
    expect(parseDateTime('в пятницу', now)).toBeNull();
  });
});
