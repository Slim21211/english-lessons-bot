import type { DateTime } from 'luxon';
import { parseDateTime } from './datetime.js';
import type { Intent } from './intent.js';

export interface RulesContext {
  now: DateTime;
  packSize: number;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[!?.,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toLocal(dt: DateTime): string {
  return dt.toFormat("yyyy-MM-dd'T'HH:mm");
}

/**
 * Быстрый разбор частых фраз без LLM. Возвращает null, если фраза сложнее —
 * тогда её разбирает модель. Специально консервативный: лучше отдать модели,
 * чем понять неправильно.
 */
export function parseByRules(raw: string, ctx: RulesContext): Intent | null {
  const text = normalize(raw);
  if (!text) return null;

  // Отмена последнего действия
  if (
    /^(undo|откат(ить|и)?|верни( как было)?|отмени последнее( действие)?|отменить последнее( действие)?)$/.test(text)
  ) {
    return { type: 'undo' };
  }

  // Вопросы о состоянии
  if (/^(сколько( осталось| занятий)?|остаток|баланс|статус|что по оплате|сколько оплачено)/.test(text)) {
    return { type: 'query', what: 'status' };
  }
  if (/^(история|что было)$/.test(text)) return { type: 'query', what: 'history' };
  if (/^(статистика|стата)$/.test(text)) return { type: 'query', what: 'stats' };
  if (/^(расписание)$/.test(text)) return { type: 'query', what: 'schedule' };

  // Оплата: «оплатил», «оплатил 4», «оплатила 8000», «заплатил 4 занятия 8000»
  if (/^(о?платил[а]?|заплатил[а]?|оплата|оплачено|перевел[а]?)(\s|$)/.test(text)) {
    // «8 000» → «8000»
    const joined = text.replace(/(\d)\s(\d{3})(?!\d)/g, '$1$2');
    const numbers = [...joined.matchAll(/\d+(?:[.,]\d+)?/g)]
      .map((m) => Number(m[0].replace(',', '.')))
      .filter((n) => Number.isFinite(n));
    let lessons = ctx.packSize;
    let amount: number | null = null;
    for (const n of numbers) {
      if (n >= 100) amount = n;
      else if (n >= 1 && n <= 30) lessons = n;
    }
    // «оплатил 4 занятия 8000», «оплатил 8000» — понятно; что-то сложнее — модели
    if (numbers.length > 2) return null;
    return { type: 'payment', lessons, amount };
  }

  // ДЗ: «дз сделано», «сделал домашку», «домашка готова» — без уточнения занятия
  const hw = '(дз|домашк[аиу]|домашнее( задание)?|домашняя( работа)?)';
  if (
    new RegExp(`^${hw} (сделан[аоы]?|готов[аоы]?)$`).test(text) ||
    new RegExp(`^(сделал[а]?|сделано|готово|выполнил[а]?) ${hw}$`).test(text)
  ) {
    return { type: 'homework_done', lesson_ref: null };
  }

  // Подтверждение, что занятие состоялось — только короткие фразы без уточнения даты
  if (/^(было|прошло|провели|состоялось|занимались|отзанимался|отзанималась|сделано|done)$/.test(text)) {
    return { type: 'lesson_status', lesson_ref: null, status: 'done' };
  }
  if (/^(в силе|будет|состоится|подтверждаю)$/.test(text)) {
    return { type: 'lesson_status', lesson_ref: null, status: 'confirmed' };
  }
  if (/^(не было|отмена|отменили|отменилось|отменил[а]?|не состоялось)$/.test(text)) {
    return { type: 'lesson_status', lesson_ref: null, status: 'cancelled' };
  }
  if (/^(сгорело|сгорел[ао]?|отменили,? но сгорело|списали)$/.test(text)) {
    return { type: 'lesson_status', lesson_ref: null, status: 'burned' };
  }

  // Перенос: «перенесли на пт 18:00», «перенос на завтра в 17» — только если дата однозначна
  const move = /^(перенес(ли|ла|ли занятие)?|перенос|перенести|переносим)\s(на\s)?(.+)$/.exec(text);
  if (move?.[4]) {
    const dt = parseDateTime(move[4], ctx.now);
    if (dt) return { type: 'reschedule', lesson_ref: null, new_datetime: toLocal(dt) };
    return null;
  }

  return null;
}
