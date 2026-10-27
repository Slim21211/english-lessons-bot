import { config } from '../src/config.js';
import { bearer, json, safeEqual } from '../src/http.js';
import { runTick } from '../src/jobs/tick.js';

/** Вызывается из Supabase pg_cron каждые 5 минут. */
export async function POST(request: Request): Promise<Response> {
  if (!safeEqual(bearer(request), config().TICK_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }
  try {
    const result = await runTick();
    if (result.errors.length > 0) console.error('Tick finished with errors', result.errors);
    return json(result);
  } catch (error) {
    console.error('Tick failed', error);
    return json({ error: error instanceof Error ? error.message : 'tick failed' }, 500);
  }
}
