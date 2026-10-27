/**
 * Запускается из CI после деплоя на Vercel:
 * 1. регистрирует webhook Telegram с секретом;
 * 2. обновляет список команд в меню бота;
 * 3. записывает адрес /api/tick и секрет в Supabase Vault, откуда их берёт pg_cron.
 *
 * Нужные переменные: APP_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TICK_SECRET.
 */
import { createClient } from '@supabase/supabase-js';
import { Api } from 'grammy';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

async function main(): Promise<void> {
  const appUrl = env('APP_URL').replace(/\/$/, '');
  if (!appUrl.startsWith('https://')) throw new Error('APP_URL must start with https://');

  const api = new Api(env('TELEGRAM_BOT_TOKEN'));

  await api.setWebhook(`${appUrl}/api/telegram`, {
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

  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });
  const { error } = await supabase.rpc('configure_tick', {
    p_url: `${appUrl}/api/tick`,
    p_secret: env('TICK_SECRET'),
  });
  if (error) throw new Error(`configure_tick: ${error.message}`);
  console.log('Tick URL and secret stored in Supabase Vault');

  // Проверка: тик отвечает
  const response = await fetch(`${appUrl}/api/tick`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('TICK_SECRET')}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await response.text();
  console.log(`Tick check: HTTP ${response.status} ${body.slice(0, 300)}`);
  if (!response.ok) throw new Error('Tick endpoint is not healthy');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
