import { describe, it, expect, vi } from 'vitest';
import { extractMemories } from './memory_extractor.js';
import type { MemoryService, SearchResult } from '../memory/types.js';
import type { LLMClient, LLMResponse } from '../llm/types.js';

function createMockLLMClient(extractedItems: Array<{ key: string; value: string; scope: string }>): LLMClient {
  return {
    chat: async () => {
      const json = JSON.stringify({
        extracted: extractedItems,
        reason: 'test',
      });
      return {
        content: [{ type: 'text' as const, text: json }],
        stop_reason: 'end_turn' as const,
      } satisfies LLMResponse;
    },
  };
}

function createMockMemory(similarScore: number): MemoryService {
  const stored = new Map<string, string>();

  return {
    setUserId: vi.fn(),
    setFact: vi.fn(),
    getFact: async (key: string) => stored.get(key) ?? null,
    listFacts: vi.fn(async () => []),
    deleteFact: vi.fn(),
    index: vi.fn(),
    search: vi.fn(async () => []),
    buildContext: vi.fn(async () => null),
    remember: vi.fn(async (key: string, value: string) => {
      stored.set(key, value);
      return {
        id: crypto.randomUUID(),
        userId: 'u1',
        key,
        value,
        text: `${key}: ${value}`,
        vector: [],
        scope: 'user' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        validFrom: Date.now(),
        validUntil: 0,
        supersededBy: '',
      };
    }),
    forget: vi.fn(),
    searchAdvanced: vi.fn(async (_query: string, _opts?: unknown) => {
      if (similarScore <= 0) return [];
      return [
        {
          id: 'existing-1',
          userId: 'u1',
          key: 'job',
          value: 'engineer',
          text: 'job: engineer',
          scope: 'user' as const,
          score: similarScore,
          validFrom: Date.now(),
          validUntil: 0,
        },
      ] satisfies SearchResult[];
    }),
    listAll: vi.fn(async () => []),
    stats: vi.fn(async () => ({ user: 0, agent: 0, global: 0 })),
    getById: vi.fn(async () => null),
    deleteById: vi.fn(),
    getHistory: vi.fn(async () => []),
    searchAtTime: vi.fn(async () => []),
  } satisfies MemoryService;
}

describe('memory_extractor 语义去重门', () => {
  it('语义相似度 > 0.92 时跳过写入', async () => {
    const llm = createMockLLMClient([
      { key: 'job', value: 'engineer', scope: 'user' },
    ]);
    const memory = createMockMemory(0.95);

    const result = await extractMemories(
      [{ role: 'user', content: [{ type: 'text', text: 'I am an engineer' }] }],
      llm,
      memory,
    );

    expect(result.extracted.length).toBe(1);
    expect(memory.remember).not.toHaveBeenCalled();
  });

  it('语义相似度 ≤ 0.92 时正常写入', async () => {
    const llm = createMockLLMClient([
      { key: 'job', value: 'engineer', scope: 'user' },
    ]);
    const memory = createMockMemory(0.85);

    const result = await extractMemories(
      [{ role: 'user', content: [{ type: 'text', text: 'I am an engineer' }] }],
      llm,
      memory,
    );

    expect(result.extracted.length).toBe(1);
    expect(memory.remember).toHaveBeenCalled();
  });

  it('无相似记忆时正常写入', async () => {
    const llm = createMockLLMClient([
      { key: 'hobby', value: 'photography', scope: 'user' },
    ]);
    const memory = createMockMemory(0);

    const result = await extractMemories(
      [{ role: 'user', content: [{ type: 'text', text: 'My hobby is photography' }] }],
      llm,
      memory,
    );

    expect(result.extracted.length).toBe(1);
    expect(memory.remember).toHaveBeenCalled();
  });
});
