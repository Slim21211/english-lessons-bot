import type { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { computeBalance } from '../src/domain/balance.js';
import { noticeKey, type PlannerSettings, plan } from '../src/domain/planner.js';
import type { Lesson } from '../src/domain/types.js';
import { at, lesson, ZONE } from './helpers.js';

const settings: PlannerSettings = {
  morningHour: 10,
  postLessonDelayMin: 10,
  payRemindThreshold: 1,
  payRemindHour: 12,
  weeklyDigest: true,
  weeklyDigestHour: 20,
  autoDoneAfterHours: 0,
};

function run(
  now: DateTime,
  lessons: Lesson[],
  opts: {
    credits?: number;
    used?: number;
    sent?: string[];
    snooze?: DateTime;
    settings?: Partial<PlannerSettings>;
  } = {},
) {
  const balance = computeBalance({ credits: opts.credits ?? 10, used: opts.used ?? 0, lessons, now, zone: ZONE });
  return plan({
    now,
    zone: ZONE,
    lessons,
    balance,
    sent: new Set(opts.sent ?? []),
    paySnoozedUntil: opts.snooze ?? null,
    settings: { ...settings, ...opts.settings },
  });
}

// 2 ноября 2026 — понедельник
describe('plan', () => {
  const mon = lesson('2026-11-02T16:40');

  it('утром спрашивает, в силе ли занятие', () => {
    expect(run(at('2026-11-02T09:59'), [mon])).toEqual([]);
    expect(run(at('2026-11-02T10:00'), [mon]).map((n) => n.kind)).toEqual(['morning']);
  });

  it('не спрашивает утром, если уже подтверждено или уже спросили', () => {
    const confirmed = { ...mon, status: 'confirmed' as const };
    expect(run(at('2026-11-02T11:00'), [confirmed])).toEqual([]);
    expect(run(at('2026-11-02T11:00'), [mon], { sent: [noticeKey.morning(mon.id)] })).toEqual([]);
  });

  it('не спрашивает утром о занятии раньше утреннего часа', () => {
    const early = lesson('2026-11-02T09:00');
    expect(run(at('2026-11-02T08:00'), [early]).filter((n) => n.kind === 'morning')).toEqual([]);
  });

  it('после занятия спрашивает, было ли оно', () => {
    expect(run(at('2026-11-02T17:49'), [mon], { sent: [noticeKey.morning(mon.id)] })).toEqual([]);
    expect(run(at('2026-11-02T17:50'), [mon], { sent: [noticeKey.morning(mon.id)] }).map((n) => n.kind)).toEqual([
      'post',
    ]);
  });

  it('на следующее утро повторяет один раз', () => {
    const sent = [noticeKey.morning(mon.id), noticeKey.post(mon.id)];
    expect(run(at('2026-11-02T23:00'), [mon], { sent })).toEqual([]);
    expect(run(at('2026-11-03T10:00'), [mon], { sent }).map((n) => n.kind)).toEqual(['post_nag']);
    expect(run(at('2026-11-03T15:00'), [mon], { sent: [...sent, noticeKey.postNag(mon.id)] })).toEqual([]);
  });

  it('отмеченное занятие больше не трогает', () => {
    expect(run(at('2026-11-02T18:00'), [{ ...mon, status: 'done' }])).toEqual([]);
  });

  it('автоотметка, если включена', () => {
    const sent = [noticeKey.post(mon.id), noticeKey.postNag(mon.id)];
    const notices = run(at('2026-11-04T18:00'), [mon], { sent, settings: { autoDoneAfterHours: 48 } });
    expect(notices.map((n) => n.kind)).toEqual(['auto_done']);
  });

  describe('оплата', () => {
    const next = lesson('2026-11-04T16:40');

    it('напоминает, когда впереди осталось оплаченных не больше порога', () => {
      const now = at('2026-11-03T12:00');
      expect(run(now, [next], { credits: 4, used: 3 }).map((n) => n.kind)).toEqual(['payment']);
      expect(run(now, [next], { credits: 4, used: 2 })).toEqual([]);
    });

    it('не раньше часа напоминаний и не дважды в день', () => {
      expect(run(at('2026-11-03T11:59'), [next], { credits: 4, used: 4 })).toEqual([]);
      const key = noticeKey.payment(at('2026-11-03T12:00'));
      expect(run(at('2026-11-03T15:00'), [next], { credits: 4, used: 4, sent: [key] })).toEqual([]);
    });

    it('учитывает «напомнить завтра»', () => {
      const snooze = at('2026-11-04T12:00');
      expect(run(at('2026-11-03T15:00'), [next], { credits: 4, used: 4, snooze })).toEqual([]);
      expect(run(at('2026-11-04T12:00'), [next], { credits: 4, used: 4, snooze }).map((n) => n.kind)).toContain(
        'payment',
      );
    });

    it('молчит, если занятий в ближайшие две недели нет', () => {
      const far = lesson('2026-12-01T16:40');
      expect(run(at('2026-11-03T12:00'), [far], { credits: 4, used: 4 })).toEqual([]);
    });
  });

  it('итоги недели в воскресенье вечером', () => {
    expect(run(at('2026-11-01T19:59'), [])).toEqual([]);
    expect(run(at('2026-11-01T20:00'), []).map((n) => n.kind)).toEqual(['weekly']);
    expect(run(at('2026-11-01T20:00'), [], { settings: { weeklyDigest: false } })).toEqual([]);
  });
});
