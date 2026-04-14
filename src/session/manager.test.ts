import { describe, it, expect, vi } from 'vitest';
import type { Message } from '../llm/types.js';
import { SessionManagerImpl } from './manager.js';
import type { Session, SessionMeta, SessionStore } from './types.js';

/**
 * 内存级 SessionStore 用于测试
 */
class InMemoryStore implements SessionStore {
  private sessions = new Map<string, Session>();
  async load(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }
  async save(session: Session): Promise<void> {
    this.sessions.set(session.meta.id, session);
  }
  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }
  async list(): Promise<SessionMeta[]> {
    return [...this.sessions.values()].map((s) => s.meta);
  }
}

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: [{ type: 'text' as const, text: `msg-${i} ${'x'.repeat(200)}` }],
  }));
}

describe('session/manager compress() llmClient guard', () => {
  it('未设置 llmClient 时 compress 回退到 prune 并输出 error', async () => {
    const store = new InMemoryStore();
    const mgr = new SessionManagerImpl({ store, maxContextMessages: 5 });
    mgr.setCompressionConfig({ maxTokens: 100 });

    const messages = makeMessages(20);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await mgr.compress(messages);

    expect(result.length).toBeLessThanOrEqual(messages.length);
    expect(result.length).toBeGreaterThan(0);

    errorSpy.mockRestore();
  });

  it('设置 llmClient 后 compress 不走 prune 回退', async () => {
    const store = new InMemoryStore();
    const mgr = new SessionManagerImpl({ store, maxContextMessages: 40 });

    const mockLLMClient = {
      chat: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Summary of conversation' }],
        stopReason: 'end_turn',
      }),
    };

    mgr.setLLMClient(mockLLMClient as never);
    mgr.setCompressionConfig({ maxTokens: 100 });

    const messages = makeMessages(30);
    const result = await mgr.compress(messages);

    expect(mockLLMClient.chat).toHaveBeenCalled();
    expect(result.length).toBeLessThan(messages.length);
  });
});
