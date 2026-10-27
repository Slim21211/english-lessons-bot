import type { DateTime } from 'luxon';

const MONTHS: Array<[RegExp, number]> = [
  [/^янв/, 1],
  [/^фев/, 2],
  [/^мар/, 3],
  [/^апр/, 4],
  [/^ма[йя]/, 5],
  [/^июн/, 6],
  [/^июл/, 7],
  [/^авг/, 8],
  [/^сен/, 9],
  [/^окт/, 10],
  [/^ноя/, 11],
  [/^дек/, 12],
];

const WEEKDAYS: Array<[RegExp, number]> = [
  [/^(пн|пон|понедельник[а-я]*)$/, 1],
  [/^(вт|вторник[а-я]*)$/, 2],
  [/^(ср|сред[а-я]*)$/, 3],
  [/^(чт|четверг[а-я]*)$/, 4],
  [/^(пт|пятниц[а-я]*)$/, 5],
  [/^(сб|суббот[а-я]*)$/, 6],
  [/^(вс|воскресень[а-я]*)$/, 7],
];

export interface ParsedTime {
  hour: number;
  minute: number;
}

export interface ParseOptions {
  /** Время, если в тексте его нет (например, время переносимого занятия). */
  defaultTime?: ParsedTime;
  /** Разрешать ли дату в прошлом (для «было в понедельник»). По умолчанию — только будущее. */
  allowPast?: boolean;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[,!?]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Ищет время в тексте и возвращает его вместе с текстом без найденного фрагмента. */
export function extractTime(text: string): { time: ParsedTime | null; rest: string } {
  const src = normalize(text);

  const patterns: RegExp[] = [
    // 16:40, в 16:40
    /(?:^|\s)(?:в\s)?(\d{1,2}):(\d{2})(?=\s|$)/g,
    // в 16.40 — с предлогом точно время
    /(?:^|\s)в\s(\d{1,2})\.(\d{2})(?=\s|$)/g,
    // 16.40, 18.00 — минуты > 12 или 00 не могут быть месяцем
    /(?:^|\s)(\d{1,2})\.((?:00)|(?:1[3-9])|(?:[2-5]\d))(?=\s|$)/g,
    // в 18, в 18 часов, к 9 утра, в 7 вечера
    /(?:^|\s)(?:в|к)\s(\d{1,2})(?:\s?(?:час(?:ов|а)?|ч))?(?:\s(утра|дня|вечера))?(?=\s|$)/g,
  ];

  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const index = m.index ?? 0;
      const after = src.slice(index + m[0].length).trim();
      // «в 2 ноября» — это дата, а не время
      if (MONTHS.some(([month]) => month.test(after))) continue;
      let hour = Number(m[1]);
      const second = m[2];
      const isNumeric = second !== undefined && /^\d+$/.test(second);
      const minute = isNumeric ? Number(second) : 0;
      if (!isNumeric && (second === 'дня' || second === 'вечера') && hour < 12) hour += 12;
      if (hour > 23 || minute > 59) continue;
      const rest = `${src.slice(0, index)} ${src.slice(index + m[0].length)}`.replace(/\s+/g, ' ').trim();
      return { time: { hour, minute }, rest };
    }
  }
  return { time: null, rest: src };
}

/** Ищет дату (без времени). Возвращает начало дня в зоне now. */
export function extractDate(text: string, now: DateTime, allowPast = false): DateTime | null {
  const src = normalize(text);
  const today = now.startOf('day');

  if (/(^|\s)послезавтра(\s|$)/.test(src)) return today.plus({ days: 2 });
  if (/(^|\s)завтра(\s|$)/.test(src)) return today.plus({ days: 1 });
  if (/(^|\s)сегодня(\s|$)/.test(src)) return today;
  if (/(^|\s)позавчера(\s|$)/.test(src)) return today.minus({ days: 2 });
  if (/(^|\s)вчера(\s|$)/.test(src)) return today.minus({ days: 1 });

  // 05.11, 5.11.2026, 05.11.26, 2026-11-05
  const iso = /(^|\s)(\d{4})-(\d{2})-(\d{2})(\s|$)/.exec(src);
  if (iso) return safeDate(now, Number(iso[2]), Number(iso[3]), Number(iso[4]));

  const numeric = /(^|\s)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(\s|$)/.exec(src);
  if (numeric) {
    const day = Number(numeric[2]);
    const month = Number(numeric[3]);
    const yearRaw = numeric[4];
    if (month >= 1 && month <= 12) {
      const year = yearRaw ? (yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw)) : undefined;
      return resolveYear(now, day, month, year, allowPast);
    }
  }

  // 5 ноября
  const verbal = /(^|\s)(\d{1,2})\s([а-я]+)/.exec(src);
  if (verbal) {
    const word = verbal[3] ?? '';
    const month = MONTHS.find(([re]) => re.test(word))?.[1];
    if (month) return resolveYear(now, Number(verbal[2]), month, undefined, allowPast);
  }

  // пятница, в пятницу, в следующую среду, в прошлый понедельник
  const words = src.split(' ');
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    const weekday = WEEKDAYS.find(([re]) => re.test(word))?.[1];
    if (!weekday) continue;
    const prev = words[i - 1] ?? '';
    const isNext = /^следующ/.test(prev);
    const isLast = /^(прошл|прошедш)/.test(prev);
    if (isLast || (allowPast && !isNext)) {
      // Ближайший такой день, не позже сегодня
      let diff = (today.weekday - weekday + 7) % 7;
      if (isLast && diff === 0) diff = 7;
      return today.minus({ days: diff });
    }
    let diff = (weekday - today.weekday + 7) % 7;
    if (isNext && diff === 0) diff = 7;
    return today.plus({ days: diff });
  }

  return null;
}

/**
 * Полная дата и время. Если указан только день недели и время уже прошло — берётся следующая неделя.
 * Возвращает null, если не удалось понять дату или время.
 */
export function parseDateTime(text: string, now: DateTime, options: ParseOptions = {}): DateTime | null {
  const { time: foundTime, rest } = extractTime(text);
  const time = foundTime ?? options.defaultTime ?? null;
  const date = extractDate(rest, now, options.allowPast ?? false);
  if (!time) return null;

  if (!date) {
    // Только время: сегодня, если ещё не прошло, иначе завтра.
    const candidate = now.startOf('day').set({ hour: time.hour, minute: time.minute });
    if (options.allowPast) return candidate;
    return candidate > now ? candidate : candidate.plus({ days: 1 });
  }

  let result = date.set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });
  const isWeekdayOnly = !/\d/.test(rest) && !/(сегодня|завтра|вчера)/.test(rest);
  if (!options.allowPast && isWeekdayOnly && result <= now) result = result.plus({ weeks: 1 });
  return result;
}

function safeDate(now: DateTime, year: number, month: number, day: number): DateTime | null {
  const dt = now.startOf('day').set({ year, month, day });
  return dt.isValid && dt.month === month && dt.day === day ? dt : null;
}

/** Дата без года: ближайшая в будущем (или в прошлом, если allowPast и она ближе). */
function resolveYear(
  now: DateTime,
  day: number,
  month: number,
  year: number | undefined,
  allowPast: boolean,
): DateTime | null {
  if (year) return safeDate(now, year, month, day);
  const thisYear = safeDate(now, now.year, month, day);
  if (!thisYear) return null;
  const today = now.startOf('day');
  if (thisYear >= today) return thisYear;
  if (allowPast && today.diff(thisYear, 'days').days < 180) return thisYear;
  return safeDate(now, now.year + 1, month, day);
}
