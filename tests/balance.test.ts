import { describe, expect, it } from 'vitest';
import { computeBalance } from '../src/domain/balance.js';
import { at, lesson, ZONE } from './helpers.js';

describe('computeBalance', () => {
  const now = at('2026-10-27T10:00');

  it('считает остаток и покрытие будущих занятий', () => {
    const lessons = [
      lesson('2026-10-28T16:40'),
      lesson('2026-11-02T16:40'),
      lesson('2026-11-04T16:40'),
      lesson('2026-11-09T16:40'),
    ];
    const b = computeBalance({ credits: 8, used: 6, lessons, now, zone: ZONE });
    expect(b.remaining).toBe(2);
    expect(b.paidAhead).toBe(2);
    expect(b.coverage.map((c) => c.paid)).toEqual([true, true, false, false]);
    expect(b.paidUntil?.id).toBe(lessons[1]?.id);
    expect(b.firstUnpaid?.id).toBe(lessons[2]?.id);
  });

  it('неотмеченные прошедшие занятия съедают остаток первыми', () => {
    const past = lesson('2026-10-26T16:40');
    const future = lesson('2026-10-28T16:40');
    const b = computeBalance({ credits: 4, used: 3, lessons: [future, past], now, zone: ZONE });
    expect(b.pendingPast.map((l) => l.id)).toEqual([past.id]);
    expect(b.paidAhead).toBe(0);
    expect(b.firstUnpaid?.id).toBe(future.id);
    expect(b.paidUntil).toBeNull();
  });

  it('идущее прямо сейчас занятие считается будущим', () => {
    const current = lesson('2026-10-27T09:30');
    const b = computeBalance({ credits: 1, used: 0, lessons: [current], now, zone: ZONE });
    expect(b.pendingPast).toHaveLength(0);
    expect(b.upcoming).toHaveLength(1);
  });

  it('показывает долг', () => {
    const b = computeBalance({ credits: 4, used: 5, lessons: [], now, zone: ZONE });
    expect(b.remaining).toBe(-1);
    expect(b.paidAhead).toBe(-1);
  });

  it('игнорирует закрытые занятия в списке', () => {
    const b = computeBalance({
      credits: 4,
      used: 1,
      lessons: [lesson('2026-10-28T16:40', 'cancelled'), lesson('2026-10-29T16:40', 'confirmed')],
      now,
      zone: ZONE,
    });
    expect(b.upcoming).toHaveLength(1);
  });
});
