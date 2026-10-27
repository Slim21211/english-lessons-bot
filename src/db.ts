import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import type { ActionLogEntry, Entity, Lesson, LoggedOp, Pause, Payment, Slot } from './domain/types.js';
import { currentUserId } from './user.js';

let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
  if (client) return client;
  const cfg = config();
  client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Таблица с фильтром по текущему пользователю — все чтения, изменения и удаления идут через неё. */
type Table = 'schedule_slots' | 'lessons' | 'payments' | 'pauses' | 'notifications' | 'bot_state' | 'action_log';
const mine = (table: Table) => ({
  // Без схемы БД строки нетипизированы; as '*' не даёт TS вывести «ошибку разбора» из строки колонок
  select: (columns = '*') =>
    db()
      .from(table)
      .select(columns as '*')
      .eq('user_id', currentUserId()),
  update: (patch: Record<string, unknown>) => db().from(table).update(patch).eq('user_id', currentUserId()),
  delete: () => db().from(table).delete().eq('user_id', currentUserId()),
});
const withUser = <T extends object>(row: T) => ({ ...row, user_id: currentUserId() });

function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data as T;
}

const normalizePayment = (p: Payment): Payment => ({ ...p, amount: p.amount === null ? null : Number(p.amount) });

// ---------- Расписание и паузы ----------

export async function getActiveSlots(): Promise<Slot[]> {
  return must(await mine('schedule_slots').select().eq('active', true).order('weekday').order('start_time'), 'slots');
}

export async function replaceSlots(slots: Array<Omit<Slot, 'id' | 'active'>>): Promise<void> {
  must(await mine('schedule_slots').update({ active: false }).eq('active', true).select('id'), 'deactivate slots');
  must(
    await db()
      .from('schedule_slots')
      .insert(slots.map((s) => withUser({ ...s, active: true })))
      .select('id'),
    'insert slots',
  );
}

export async function getPauses(fromDate: string): Promise<Pause[]> {
  return must(await mine('pauses').select().gte('ends_on', fromDate).order('starts_on'), 'pauses');
}

// ---------- Занятия ----------

export async function insertGeneratedLessons(
  rows: Array<{ slot_key: string; starts_at: string; duration_min: number }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const data = must(
    await db()
      .from('lessons')
      .upsert(rows.map(withUser), { onConflict: 'user_id,slot_key', ignoreDuplicates: true })
      .select('id'),
    'insert generated lessons',
  );
  return data.length;
}

export async function getLessonsBetween(fromIso: string, toIso: string): Promise<Lesson[]> {
  return must(
    await mine('lessons').select().gte('starts_at', fromIso).lt('starts_at', toIso).order('starts_at'),
    'lessons between',
  );
}

export async function getOpenLessons(): Promise<Lesson[]> {
  return must(await mine('lessons').select().in('status', ['planned', 'confirmed']).order('starts_at'), 'open lessons');
}

export async function getLesson(id: string): Promise<Lesson | null> {
  return must(await mine('lessons').select().eq('id', id).maybeSingle(), 'lesson');
}

export async function getRecentResolvedLessons(limit: number): Promise<Lesson[]> {
  return must(
    await mine('lessons')
      .select()
      .not('status', 'in', '(planned,confirmed)')
      .order('resolved_at', { ascending: false, nullsFirst: false })
      .limit(limit),
    'recent lessons',
  );
}

/** Будущие занятия из расписания, которые ещё никак не отмечены, — их можно пересоздавать. */
export async function getFutureGeneratedLessons(afterIso: string): Promise<Lesson[]> {
  return must(
    await mine('lessons').select().eq('status', 'planned').not('slot_key', 'is', null).gt('starts_at', afterIso),
    'future generated lessons',
  );
}

export async function deleteLessons(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  must(await mine('lessons').delete().in('id', ids).select('id'), 'delete lessons');
}

export async function getAllLessonsSince(fromIso: string): Promise<Lesson[]> {
  return must(await mine('lessons').select().gte('starts_at', fromIso).order('starts_at'), 'lessons since');
}

// ---------- Оплаты и баланс ----------

export async function getBalanceTotals(): Promise<{ credits: number; used: number }> {
  const data = must(await db().rpc('balance_totals', { p_user_id: currentUserId() }), 'balance totals') as Array<{
    credits: number;
    used: number;
  }>;
  const row = data[0] ?? { credits: 0, used: 0 };
  return { credits: Number(row.credits), used: Number(row.used) };
}

export async function getRecentPayments(limit: number): Promise<Payment[]> {
  const data: Payment[] = must(
    await mine('payments').select().order('paid_at', { ascending: false }).limit(limit),
    'recent payments',
  );
  return data.map(normalizePayment);
}

export async function getPaymentsSince(fromIso: string): Promise<Payment[]> {
  const data: Payment[] = must(
    await mine('payments').select().gte('paid_at', fromIso).order('paid_at'),
    'payments since',
  );
  return data.map(normalizePayment);
}

// ---------- Универсальные операции с журналом ----------

export async function insertRow<T extends { id: string | number }>(
  entity: Entity,
  row: Record<string, unknown>,
): Promise<T> {
  return must(await db().from(entity).insert(withUser(row)).select('*').single(), `insert ${entity}`);
}

export async function updateRow<T>(entity: Entity, id: string, patch: Record<string, unknown>): Promise<T> {
  return must(await mine(entity).update(patch).eq('id', id).select('*').single(), `update ${entity}`);
}

export async function deleteRow(entity: Entity, id: string): Promise<void> {
  must(await mine(entity).delete().eq('id', id).select('id'), `delete ${entity}`);
}

export async function getRow<T>(entity: Entity, id: string): Promise<T | null> {
  return must(await mine(entity).select().eq('id', id).maybeSingle(), `get ${entity}`);
}

export async function logAction(kind: string, summary: string, ops: LoggedOp[]): Promise<number> {
  const data = must(
    await db().from('action_log').insert(withUser({ kind, summary, ops })).select('id').single(),
    'log action',
  ) as { id: number };
  return data.id;
}

export async function getActionLog(id: number): Promise<ActionLogEntry | null> {
  return must(await mine('action_log').select().eq('id', id).maybeSingle(), 'action log');
}

export async function getLastActionLog(): Promise<ActionLogEntry | null> {
  return must(
    await mine('action_log').select().is('undone_at', null).order('id', { ascending: false }).limit(1).maybeSingle(),
    'last action log',
  );
}

export async function markActionUndone(id: number): Promise<void> {
  must(
    await mine('action_log').update({ undone_at: new Date().toISOString() }).eq('id', id).select('id'),
    'mark undone',
  );
}

// ---------- Уведомления ----------

export async function getSentNotificationKeys(sinceIso: string): Promise<Set<string>> {
  const data = must(await mine('notifications').select('key').gte('sent_at', sinceIso), 'notification keys') as Array<{
    key: string;
  }>;
  return new Set(data.map((r) => r.key));
}

/** Атомарно «занимает» ключ. false — уже отправлено другим тиком. */
export async function claimNotification(key: string, payload: Record<string, unknown> = {}): Promise<boolean> {
  const data = must(
    await db()
      .from('notifications')
      .upsert(withUser({ key, payload }), { onConflict: 'user_id,key', ignoreDuplicates: true })
      .select('key'),
    'claim notification',
  ) as Array<{ key: string }>;
  return data.length > 0;
}

export async function setNotificationMessage(key: string, messageId: number): Promise<void> {
  must(await mine('notifications').update({ message_id: messageId }).eq('key', key).select('key'), 'notif msg');
}

export async function releaseNotification(key: string): Promise<void> {
  must(await mine('notifications').delete().eq('key', key).select('key'), 'release notification');
}

// ---------- Состояние диалога ----------

export async function getState<T>(key: string): Promise<T | null> {
  const row = must(await mine('bot_state').select('value, expires_at').eq('key', key).maybeSingle(), 'get state') as {
    value: T;
    expires_at: string | null;
  } | null;
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  return row.value;
}

export async function setState(key: string, value: unknown, ttlMinutes?: number): Promise<void> {
  const expires_at = ttlMinutes ? new Date(Date.now() + ttlMinutes * 60_000).toISOString() : null;
  must(
    await db()
      .from('bot_state')
      .upsert(withUser({ key, value, expires_at, updated_at: new Date().toISOString() }), { onConflict: 'user_id,key' })
      .select('key'),
    'set state',
  );
}

export async function deleteState(key: string): Promise<void> {
  must(await mine('bot_state').delete().eq('key', key).select('key'), 'delete state');
}
