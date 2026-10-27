import { describe, expect, it } from 'vitest';
import { currentUserId, runAs } from '../src/user.js';

describe('текущий пользователь', () => {
  it('виден внутри runAs, в том числе после await', async () => {
    const seen = await runAs(42, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentUserId();
    });
    expect(seen).toBe(42);
  });

  it('параллельные вызовы не путают пользователей', async () => {
    const check = (id: number) =>
      runAs(id, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5 - id));
        return currentUserId();
      });
    expect(await Promise.all([check(1), check(2), check(3)])).toEqual([1, 2, 3]);
  });

  it('без runAs — ошибка, а не запрос без фильтра', () => {
    expect(() => currentUserId()).toThrow(/runAs/);
  });
});
