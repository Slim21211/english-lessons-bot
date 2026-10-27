import { z } from 'zod';

const hour = z.coerce.number().int().min(0).max(23);

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  /** Секрет, который Telegram присылает в заголовке X-Telegram-Bot-Api-Secret-Token. */
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/, 'только A-Z a-z 0-9 _ -, от 16 символов'),
  /** Свой Bot API сервер или прокси; по умолчанию официальный. */
  TELEGRAM_API_ROOT: z.url().optional(),
  /** Ваш Telegram user id. Бот отвечает только ему и шлёт уведомления ему же. */
  OWNER_TELEGRAM_ID: z.coerce.number().int().positive(),

  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  /** Секрет для /api/tick (его же CI кладёт в Supabase Vault). */
  TICK_SECRET: z.string().min(16),

  /** Часовой пояс. Переменная TZ на Vercel зарезервирована, поэтому отдельное имя. */
  TIME_ZONE: z.string().default('Europe/Moscow'),
  /** Сколько занятий в пакете оплаты по умолчанию. */
  PACK_SIZE: z.coerce.number().int().positive().default(4),
  DEFAULT_DURATION_MIN: z.coerce.number().int().positive().default(60),
  /** Во сколько утром спрашивать «занятие в силе?» и повторно про неотмеченные. */
  MORNING_HOUR: hour.default(10),
  /** Через сколько минут после конца занятия спрашивать, было ли оно. */
  POST_LESSON_DELAY_MIN: z.coerce.number().int().min(0).default(10),
  /** Напоминать об оплате, когда оплаченных впереди осталось столько или меньше. */
  PAY_REMIND_THRESHOLD: z.coerce.number().int().min(0).default(1),
  PAY_REMIND_HOUR: hour.default(12),
  WEEKLY_DIGEST: z.enum(['on', 'off']).default('on'),
  WEEKLY_DIGEST_HOUR: hour.default(20),
  /** Если > 0: неотмеченное занятие через N часов считается состоявшимся. 0 — выключено. */
  AUTO_DONE_AFTER_HOURS: z.coerce.number().int().min(0).default(0),
  /** На сколько дней вперёд создавать занятия из расписания. */
  HORIZON_DAYS: z.coerce.number().int().min(7).max(90).default(28),

  /** Порядок провайдеров LLM через запятую: groq, openrouter, custom. */
  LLM_PROVIDERS: z.string().default('groq,openrouter'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  OPENROUTER_API_KEY: z.string().optional(),
  /** Можно несколько через запятую — OpenRouter сам перейдёт к следующей при ошибке. */
  OPENROUTER_MODELS: z.string().default('openrouter/free'),
  /** Любой OpenAI-совместимый endpoint (например, свой прокси или локальная модель). */
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Только для тестов. */
export function setConfigForTests(partial: Partial<Config>): void {
  cached = {
    ...schema.parse({
      TELEGRAM_BOT_TOKEN: 'test',
      TELEGRAM_WEBHOOK_SECRET: 'test_secret_123456',
      OWNER_TELEGRAM_ID: '1',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test',
      TICK_SECRET: 'test_tick_secret_123',
    }),
    ...partial,
  };
}
