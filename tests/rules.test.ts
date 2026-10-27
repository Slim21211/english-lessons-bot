import { describe, expect, it } from 'vitest';
import { parseByRules } from '../src/nlu/rules.js';
import { at } from './helpers.js';

const ctx = { now: at('2026-10-27T10:00'), packSize: 4 };

describe('parseByRules', () => {
  it.each([
    ['было', { type: 'lesson_status', lesson_ref: null, status: 'done' }],
    ['Было!', { type: 'lesson_status', lesson_ref: null, status: 'done' }],
    ['не было', { type: 'lesson_status', lesson_ref: null, status: 'cancelled' }],
    ['отменили', { type: 'lesson_status', lesson_ref: null, status: 'cancelled' }],
    ['сгорело', { type: 'lesson_status', lesson_ref: null, status: 'burned' }],
    ['в силе', { type: 'lesson_status', lesson_ref: null, status: 'confirmed' }],
    ['сколько осталось?', { type: 'query', what: 'status' }],
    ['статус', { type: 'query', what: 'status' }],
    ['undo', { type: 'undo' }],
    ['отмени последнее', { type: 'undo' }],
    ['дз сделано', { type: 'homework_done', lesson_ref: null }],
    ['ДЗ готово!', { type: 'homework_done', lesson_ref: null }],
    ['сделал домашку', { type: 'homework_done', lesson_ref: null }],
    ['домашнее задание сделано', { type: 'homework_done', lesson_ref: null }],
    ['сделано', { type: 'lesson_status', lesson_ref: null, status: 'done' }],
  ])('%s', (text, expected) => {
    expect(parseByRules(text, ctx)).toEqual(expected);
  });

  it.each([
    ['оплатил', 4, null],
    ['оплатил 4', 4, null],
    ['оплатила 8000', 4, 8000],
    ['оплатил 8 000', 4, 8000],
    ['оплатил 4 занятия 8000', 4, 8000],
    ['заплатил 8 занятий', 8, null],
  ])('оплата: %s', (text, lessons, amount) => {
    expect(parseByRules(text, ctx)).toEqual({ type: 'payment', lessons, amount });
  });

  it('перенос с понятной датой', () => {
    expect(parseByRules('перенесли на пт 18:00', ctx)).toEqual({
      type: 'reschedule',
      lesson_ref: null,
      new_datetime: '2026-10-30T18:00',
    });
  });

  it('сложные фразы отдаёт модели', () => {
    expect(parseByRules('перенесли на когда-нибудь потом', ctx)).toBeNull();
    expect(parseByRules('в понедельник было, а в среду отменили', ctx)).toBeNull();
    expect(parseByRules('на каникулах с 28 декабря по 10 января занятий не будет', ctx)).toBeNull();
  });
});
