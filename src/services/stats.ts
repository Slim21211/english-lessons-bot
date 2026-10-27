import type { MonthStats } from '../bot/views.js';
import type { Lesson, Payment } from '../domain/types.js';
import { lessonStart } from '../time.js';

const MONTHS_NOM = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

/** Группирует занятия и оплаты по месяцам (в локальной зоне), новые месяцы — сверху. */
export function buildMonthStats(lessons: Lesson[], payments: Payment[], zone: string): MonthStats[] {
  const map = new Map<string, MonthStats>();
  const bucket = (iso: string): MonthStats => {
    const dt = lessonStart({ starts_at: iso }, zone);
    const key = dt.toFormat('yyyy-MM');
    let entry = map.get(key);
    if (!entry) {
      entry = {
        month: `${MONTHS_NOM[dt.month - 1]} ${dt.year}`,
        done: 0,
        burned: 0,
        cancelled: 0,
        bought: 0,
        spent: 0,
        priced: 0,
      };
      map.set(key, entry);
    }
    return entry;
  };

  for (const l of lessons) {
    if (l.status === 'done') bucket(l.starts_at).done++;
    else if (l.status === 'burned') bucket(l.starts_at).burned++;
    else if (l.status === 'cancelled') bucket(l.starts_at).cancelled++;
  }
  for (const p of payments) {
    if (p.kind !== 'payment') continue;
    const b = bucket(p.paid_at);
    b.bought += p.lessons;
    if (p.amount !== null) {
      b.spent += p.amount;
      b.priced += p.lessons;
    }
  }

  return [...map.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([, v]) => v);
}
