import { z } from 'zod';

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:mm');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
/** Ссылка на занятие из контекста (L1, L2, …) или null — «текущее по смыслу». */
const lessonRef = z
  .string()
  .regex(/^L\d+$/)
  .nullable()
  .default(null);

export const IntentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('lesson_status'),
    lesson_ref: lessonRef,
    status: z.enum(['done', 'cancelled', 'burned', 'confirmed']),
  }),
  z.object({
    type: z.literal('reschedule'),
    lesson_ref: lessonRef,
    new_datetime: localDateTime,
  }),
  z.object({
    type: z.literal('add_lesson'),
    datetime: localDateTime,
    duration_min: z.number().int().min(10).max(600).nullable().default(null),
  }),
  z.object({
    type: z.literal('payment'),
    lessons: z.number().int().min(1).max(100),
    amount: z.number().min(0).nullable().default(null),
  }),
  z.object({
    type: z.literal('set_balance'),
    remaining: z.number().int().min(-50).max(200),
  }),
  z.object({
    type: z.literal('pause'),
    from: localDate,
    to: localDate,
  }),
  z.object({
    type: z.literal('query'),
    what: z.enum(['status', 'history', 'stats', 'schedule']),
  }),
  z.object({ type: z.literal('undo') }),
  z.object({ type: z.literal('chat'), reply: z.string().min(1).max(1000) }),
]);

export type Intent = z.infer<typeof IntentSchema>;

/** Действия, которые меняют данные и требуют подтверждения, если их понял LLM. */
export const MUTATING_INTENTS: ReadonlySet<Intent['type']> = new Set([
  'lesson_status',
  'reschedule',
  'add_lesson',
  'payment',
  'set_balance',
  'pause',
  'undo',
]);
