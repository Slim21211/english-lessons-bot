/**
 * Локальный запуск бота для проверки перед деплоем: `npm run dev`.
 * - Telegram webhook снимается, бот получает апдейты long polling'ом прямо с этой машины.
 * - Тик планировщика крутится локально раз в минуту (идемпотентен, дубли уведомлений не шлёт).
 * - По Ctrl+C webhook возвращается на прод (если задан APP_URL).
 */
import { DateTime } from 'luxon';
import { getBot } from '../src/bot/index.js';
import { config } from '../src/config.js';
import { runTick } from '../src/jobs/tick.js';
import { setProdWebhook } from './webhook.js';

const TICK_EVERY_MS = 60_000;

const bot = getBot();
let timer: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  try {
    const result = await runTick(DateTime.now().setZone(config().TIME_ZONE));
    if (result.sent.length > 0 || result.errors.length > 0 || result.generated > 0) {
      console.log('Tick', JSON.stringify(result));
    }
  } catch (error) {
    console.error('Tick failed', error);
  }
}

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await bot.stop();
  if (process.env.APP_URL) {
    console.log('Возвращаю webhook на прод…');
    await setProdWebhook(bot.api);
  } else {
    console.log('APP_URL не задан — webhook не восстановлен. Для прода: npm run prod');
  }
  process.exit(0);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await tick();
timer = setInterval(() => void tick(), TICK_EVERY_MS);

await bot.start({
  allowed_updates: ['message', 'callback_query'],
  onStart: (me) => console.log(`@${me.username} слушает локально (long polling). Ctrl+C — вернуть прод.`),
});
