import { Api } from 'grammy';

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

export function appUrl(): string {
  const url = env('APP_URL').replace(/\/$/, '');
  if (!url.startsWith('https://')) throw new Error('APP_URL must start with https://');
  return url;
}

export function telegramApi(): Api {
  const apiRoot = process.env.TELEGRAM_API_ROOT;
  return new Api(env('TELEGRAM_BOT_TOKEN'), apiRoot ? { apiRoot } : {});
}

/** Направляет апдейты бота на прод (Vercel /api/telegram) и обновляет меню команд. */
export async function setProdWebhook(api: Api): Promise<void> {
  await api.setWebhook(`${appUrl()}/api/telegram`, {
    secret_token: env('TELEGRAM_WEBHOOK_SECRET'),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
    max_connections: 5,
  });
  const info = await api.getWebhookInfo();
  console.log(`Webhook: ${info.url} (pending: ${info.pending_update_count})`);
  if (info.last_error_message) console.warn(`Last webhook error: ${info.last_error_message}`);

  // Импорт здесь, чтобы config() не валидировал окружение раньше времени
  const { BOT_COMMANDS } = await import('../src/bot/index.js');
  await api.setMyCommands(BOT_COMMANDS);
  console.log(`Commands: ${BOT_COMMANDS.length}`);
}
