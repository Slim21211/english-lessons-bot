import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Текущий пользователь (Telegram id). Бот задаёт его на каждый апдейт, тик — на каждого
 * пользователя по очереди; все запросы к базе ограничиваются им автоматически.
 */
const storage = new AsyncLocalStorage<number>();

export function runAs<T>(userId: number, fn: () => T): T {
  return storage.run(userId, fn);
}

export function currentUserId(): number {
  const id = storage.getStore();
  if (id === undefined) throw new Error('No current user: wrap the call in runAs()');
  return id;
}
