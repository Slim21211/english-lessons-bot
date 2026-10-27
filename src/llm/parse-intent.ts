import type { DateTime } from 'luxon';
import type { Lesson } from '../domain/types.js';
import { type Intent, IntentSchema } from '../nlu/intent.js';
import { lessonStart, WEEKDAYS_FULL, WEEKDAYS_SHORT } from '../time.js';
import { completeJson, extractJsonObject } from './client.js';

export interface LessonRef {
  ref: string;
  lesson: Lesson;
}

export interface IntentContext {
  now: DateTime;
  zone: string;
  packSize: number;
  remaining: number;
  /** Занятия рядом с текущей датой с короткими ссылками L1, L2, … */
  refs: LessonRef[];
}

const STATUS_RU: Record<Lesson['status'], string> = {
  planned: 'запланировано',
  confirmed: 'подтверждено',
  done: 'было',
  cancelled: 'отменено',
  burned: 'сгорело',
  rescheduled: 'перенесено',
};

export function buildRefs(lessons: Lesson[]): LessonRef[] {
  return [...lessons]
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .map((lesson, i) => ({ ref: `L${i + 1}`, lesson }));
}

export function buildSystemPrompt(ctx: IntentContext): string {
  // Даты в том же ISO-виде, что и «Сейчас»: с «пн 09.11» модель путала 9 и 11 ноября.
  const lines = ctx.refs.map(({ ref, lesson }) => {
    const start = lessonStart(lesson, ctx.zone);
    return `${ref}: ${start.toFormat("yyyy-MM-dd'T'HH:mm")} (${WEEKDAYS_SHORT[start.weekday - 1]}) — ${STATUS_RU[lesson.status]}`;
  });
  return [
    'Ты разбираешь сообщения в личном боте учёта занятий английским. Ответь ТОЛЬКО JSON-объектом одного из видов:',
    '{"type":"lesson_status","lesson_ref":"L3"|null,"status":"done"|"cancelled"|"burned"|"confirmed"}',
    '  done — занятие состоялось; cancelled — отменилось без оплаты; burned — отменилось, но деньги сгорели; confirmed — подтверждено, что будет.',
    '{"type":"reschedule","lesson_ref":"L3"|null,"new_datetime":"YYYY-MM-DDTHH:mm"} — перенос занятия на новое время.',
    '{"type":"homework_done","lesson_ref":"L3"|null} — домашнее задание к занятию сделано. null — к ближайшему будущему.',
    '{"type":"add_lesson","datetime":"YYYY-MM-DDTHH:mm","duration_min":число|null} — дополнительное разовое занятие.',
    `{"type":"payment","lessons":число,"amount":число|null} — оплата. Если число занятий не названо, lessons=${ctx.packSize}. amount — сумма в рублях, если названа.`,
    '{"type":"set_balance","remaining":число} — пользователь сообщает, сколько оплаченных занятий у него сейчас осталось.',
    '{"type":"pause","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} — перерыв/отпуск, занятий не будет.',
    '{"type":"query","what":"status"|"history"|"stats"|"schedule"} — вопрос: сколько осталось / что было / статистика / расписание.',
    '{"type":"undo"} — отменить последнее действие бота.',
    '{"type":"chat","reply":"короткий ответ по-русски"} — всё остальное, или если непонятно. Не выдумывай действия.',
    '',
    'Правила:',
    '- lesson_ref выбирай только из списка ниже. null — если пользователь не уточнил, какое занятие (бот возьмёт ближайшее подходящее).',
    '- Даты и время — местные, без часового пояса. «В пятницу» — ближайшая пятница в будущем, если речь о переносе или новом занятии.',
    '- Если для переноса не названо время, оставь время исходного занятия.',
    '',
    `Сейчас: ${WEEKDAYS_FULL[ctx.now.weekday - 1]}, ${ctx.now.toFormat("yyyy-MM-dd'T'HH:mm")}.`,
    `Оплаченных занятий осталось: ${ctx.remaining}.`,
    'Занятия рядом с текущей датой:',
    ...(lines.length > 0 ? lines : ['(нет)']),
  ].join('\n');
}

export async function parseIntentWithLlm(text: string, ctx: IntentContext): Promise<Intent> {
  return completeJson(
    [
      { role: 'system', content: buildSystemPrompt(ctx) },
      { role: 'user', content: text.slice(0, 1000) },
    ],
    (raw) => IntentSchema.parse(extractJsonObject(raw)),
  );
}
