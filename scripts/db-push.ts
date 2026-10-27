/**
 * Применяет миграции из supabase/migrations к проекту SUPABASE_PROJECT_REF: `npm run db:push`.
 * Один раз перед этим: `npx supabase login`. SUPABASE_DB_PASSWORD можно не задавать — CLI спросит.
 */
import { spawnSync } from 'node:child_process';
import { env } from './webhook.js';

function supabase(...args: string[]): void {
  const password = process.env.SUPABASE_DB_PASSWORD;
  const result = spawnSync('npx', ['-y', 'supabase', ...args, ...(password ? ['-p', password] : [])], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

supabase('link', '--project-ref', env('SUPABASE_PROJECT_REF'));
supabase('db', 'push', '--include-all');
