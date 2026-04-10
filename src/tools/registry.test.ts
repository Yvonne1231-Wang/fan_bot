import { describe, it, expect } from 'vitest';
import { runWithContext, getToolContext, setToolContext } from './registry.js';

/** 验证 AsyncLocalStorage 上下文隔离与兼容 setToolContext 的回退逻辑 */
describe('tools/registry context isolation', () => {
  it('不同并发上下文互不污染', async () => {
    const seen: Array<{ userId?: string; chatId?: string }> = [];

    const p1 = runWithContext({ userId: 'u1', chatId: 'c1' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(getToolContext());
    });
    const p2 = runWithContext({ userId: 'u2', chatId: 'c2' }, async () => {
      seen.push(getToolContext());
      await new Promise((r) => setTimeout(r, 10));
      seen.push(getToolContext());
    });

    await Promise.all([p1, p2]);

    const contexts = seen.map((c) => `${c.userId}-${c.chatId}`);
    // 只应出现各自上下文组合
    expect(new Set(contexts)).toEqual(new Set(['u1-c1', 'u2-c2']));
  });

  it('在无 ALS 环境下使用 setToolContext 作为回退', () => {
    setToolContext({ userId: 'u3', chatId: 'c3' });
    const ctx = getToolContext();
    expect(ctx.userId).toBe('u3');
    expect(ctx.chatId).toBe('c3');
  });
});
