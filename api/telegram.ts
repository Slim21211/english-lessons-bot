import { webhookCallback } from 'grammy';
import { getBot } from '../src/bot/index.js';
import { config } from '../src/config.js';

let handle: ((request: Request) => Promise<Response>) | undefined;

/** Webhook Telegram. Секрет проверяет сам grammY по заголовку X-Telegram-Bot-Api-Secret-Token. */
export async function POST(request: Request): Promise<Response> {
  handle ??= webhookCallback(getBot(), 'std/http', {
    secretToken: config().TELEGRAM_WEBHOOK_SECRET,
    // Разбор текста моделью может занять несколько секунд; лимит функции — 30 с.
    timeoutMilliseconds: 25_000,
    onTimeout: 'return',
  });
  return handle(request);
}
