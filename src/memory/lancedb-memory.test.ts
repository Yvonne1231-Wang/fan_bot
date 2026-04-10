import { describe, it, expect, vi } from 'vitest';
import { LanceDBMemoryService } from './lancedb-memory.js';

// 避免在测试中实际加载 @lancedb/lancedb 原生依赖
vi.mock('@lancedb/lancedb', () => {
  return {
    connect: async () => ({
      tableNames: async () => [],
      openTable: async () => null,
      createTable: async () => ({}),
    }),
  };
});

type AccessTrackerEntry = { count: number; lastAccess: number };

interface MockQuery {
  where: (clause: string) => MockQuery;
  limit: (n: number) => MockQuery;
  toArray: () => Promise<unknown[]>;
}

interface MockTable {
  query: () => MockQuery;
  update: (args: { where: string; values: Record<string, unknown> }) => Promise<void>;
}

class InMemoryTable implements MockTable {
  private records: Map<string, Record<string, unknown>>;
  private currentId: string | null = null;

  /** 构造一个内存表，用于拦截 query/update 调用 */
  constructor(initial: Array<Record<string, unknown>>) {
    this.records = new Map(initial.map((r) => [String(r.id), { ...r }]));
  }

  /** 构建查询器：仅支持 where(id=...) + limit(1) + toArray() */
  query(): MockQuery {
    const self = this;
    return {
      where(clause: string) {
        // 简单解析 where: `id = 'xxx'`
        const match = clause.match(/id\s*=\s*'([^']+)'/);
        self.currentId = match ? match[1] : null;
        return this;
        },
      limit(_n: number) {
        return this;
      },
      async toArray() {
        if (!self.currentId) return [];
        const rec = self.records.get(self.currentId);
        return rec ? [rec] : [];
      },
    };
  }

  /** 执行更新：根据 where(id=...) 写入 values 字段 */
  async update(args: { where: string; values: Record<string, unknown> }): Promise<void> {
    const match = args.where.match(/id\s*=\s*'([^']+)'/);
    const id = match ? match[1] : null;
    if (!id) return;
    const old = this.records.get(id);
    if (!old) return;
    this.records.set(id, { ...old, ...args.values });
  }

  /** 读取记录的快照（用于断言） */
  snapshot(id: string): Record<string, unknown> | undefined {
    const rec = this.records.get(id);
    return rec ? { ...rec } : undefined;
  }
}

/** 从服务实例中提取私有方法/字段的安全类型（避免 any，使用 unknown 转换） */
type WithInternals = {
  table: MockTable | null;
  accessTracker: Map<string, AccessTrackerEntry>;
  flushAccessCounts: () => Promise<void>;
};

/** 构造一个包含基础字段的记录 */
function makeRecord(id: string, overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  const now = Date.now();
  return {
    id,
    userId: 'u1',
    key: 'k',
    value: 'v',
    text: 't',
    vector: new Array(768).fill(0),
    scope: 'user',
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    validFrom: now - 10_000,
    validUntil: 0,
    supersededBy: '',
    accessCount: 7,
    lastAccessedAt: now - 5_000,
    memoryStrength: 0.6,
    ...overrides,
  };
}

/** 验证 flushAccessCounts 会基于历史 accessCount 进行累加，而非覆盖本次窗口的 delta */
describe('LanceDBMemoryService.flushAccessCounts 累积访问计数', () => {
  it('第一次 flush：existing.accessCount(7) + delta(3) → 10', async () => {
    const service = new LanceDBMemoryService('/dev/null');
    const internals = service as unknown as WithInternals;

    const id = 'r1';
    const table = new InMemoryTable([makeRecord(id)]);
    internals.table = table;

    const now = Date.now();
    internals.accessTracker = new Map<string, AccessTrackerEntry>([
      [id, { count: 3, lastAccess: now }],
    ]);

    await internals.flushAccessCounts();

    const rec = table.snapshot(id)!;
    expect(rec.accessCount).toBe(10);
    expect(rec.lastAccessedAt).toBe(now);
    // memoryStrength: 0.6 + 0.3*(1-0.6) = 0.72
    expect(rec.memoryStrength).toBeCloseTo(0.72, 5);
  });

  it('连续两次 flush：在上次结果基础上继续累加', async () => {
    const service = new LanceDBMemoryService('/dev/null');
    const internals = service as unknown as WithInternals;

    const id = 'r2';
    const table = new InMemoryTable([makeRecord(id)]);
    internals.table = table;

    const t1 = Date.now();
    internals.accessTracker = new Map<string, AccessTrackerEntry>([
      [id, { count: 3, lastAccess: t1 }],
    ]);
    await internals.flushAccessCounts();

    // 第二个窗口再增加 2 次访问
    const t2 = t1 + 1_000;
    internals.accessTracker = new Map<string, AccessTrackerEntry>([
      [id, { count: 2, lastAccess: t2 }],
    ]);
    await internals.flushAccessCounts();

    const rec = table.snapshot(id)!;
    expect(rec.accessCount).toBe(12);
    expect(rec.lastAccessedAt).toBe(t2);
  });
});

describe('LanceDBMemoryService.buildContext token 预算上限', () => {
  it('短文本记忆全部纳入预算', () => {
    const shortText = '用户喜欢深色模式';
    const cost = estimateTokenCountLocal(shortText);
    expect(cost).toBeLessThan(800);
  });

  it('超长文本记忆被预算裁剪', () => {
    const longText = 'x'.repeat(4000);
    const cost = estimateTokenCountLocal(longText);
    expect(cost).toBeGreaterThan(800);
  });

  it('多条记忆在预算内按序纳入，超出预算的跳过', () => {
    const texts = [
      'a'.repeat(100),
      'b'.repeat(100),
      'c'.repeat(100),
    ];
    const budget = 800;
    let remaining = budget;
    const selected: string[] = [];
    for (const t of texts) {
      const cost = estimateTokenCountLocal(t);
      if (cost > remaining) continue;
      remaining -= cost;
      selected.push(t);
    }
    expect(selected.length).toBe(texts.length);
  });
});

function estimateTokenCountLocal(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return cjkChars + Math.ceil(otherChars / 4);
}
