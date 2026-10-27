/**
 * Переключает бота на прод (Vercel). Запускать после первого деплоя, после смены домена/секретов
 * и после `npm run dev`, если тот был остановлен не через Ctrl+C:
 * 1. регистрирует webhook Telegram с секретом и меню команд;
 * 2. записывает адрес /api/tick и секрет в Supabase Vault, откуда их берёт pg_cron;
 * 3. проверяет, что /api/tick на проде отвечает.
 */
import { createClient } from '@supabase/supabase-js';
import { appUrl, env, setProdWebhook, telegramApi } from './webhook.js';

async function main(): Promise<void> {
  await setProdWebhook(telegramApi());

  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });
  const { error } = await supabase.rpc('configure_tick', {
    p_url: `${appUrl()}/api/tick`,
    p_secret: env('TICK_SECRET'),
  });
  if (error) throw new Error(`configure_tick: ${error.message}`);
  console.log('Tick URL and secret stored in Supabase Vault');

  let response: Response;
  try {
    response = await fetch(`${appUrl()}/api/tick`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('TICK_SECRET')}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    // Настройка уже записана; не достучались только отсюда — это сеть этой машины, а не прод.
    console.warn(
      `Tick check skipped: ${error instanceof Error ? error.message : error}. Проверьте вручную: ${appUrl()}/api/health`,
    );
    return;
  }
  const body = await response.text();
  console.log(`Tick check: HTTP ${response.status} ${body.slice(0, 300)}`);
  if (!response.ok) throw new Error('Tick endpoint is not healthy (TICK_SECRET в Vercel совпадает с .env?)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
