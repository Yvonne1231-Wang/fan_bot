// ─── Lock & Queue Tests ─────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ModificationLock, ModificationQueue } from '../lock.js';
import type { CodeChangeRequest, ModificationResult } from '../types.js';

describe('ModificationLock', () => {
  let workDir: string;
  let lock: ModificationLock;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lock-test-'));
    lock = new ModificationLock(workDir);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('应该成功获取锁', () => {
    const result = lock.acquire('Alice', 'req-1');
    expect(result.acquired).toBe(true);
  });

  it('已锁定时应该拒绝第二个获取请求', () => {
    lock.acquire('Alice', 'req-1');
    const result = lock.acquire('Bob', 'req-2');
    expect(result.acquired).toBe(false);
    expect(result.heldBy).toBe('Alice');
  });

  it('释放后应该可以再次获取', () => {
    lock.acquire('Alice', 'req-1');
    lock.release();
    const result = lock.acquire('Bob', 'req-2');
    expect(result.acquired).toBe(true);
  });

  it('isLocked 应该反映当前状态', () => {
    expect(lock.isLocked()).toBe(false);
    lock.acquire('Alice', 'req-1');
    expect(lock.isLocked()).toBe(true);
    lock.release();
    expect(lock.isLocked()).toBe(false);
  });
});

describe('ModificationQueue', () => {
  it('应该串行处理请求', async () => {
    const order: number[] = [];

    const handler = async (request: CodeChangeRequest): Promise<ModificationResult> => {
      const index = parseInt(request.description);
      // 模拟异步处理
      await new Promise((r) => setTimeout(r, 10));
      order.push(index);
      return {
        success: true,
        branch: `auto/${index}`,
        commitHash: `hash-${index}`,
        duration: 10,
      };
    };

    const queue = new ModificationQueue(handler);

    const makeRequest = (i: number): CodeChangeRequest => ({
      intent: 'modify',
      targetFile: `file-${i}.ts`,
      description: `${i}`,
      operator: { type: 'user', userId: 'u1' },
      rawMessage: `msg-${i}`,
    });

    // 同时提交 3 个请求
    const results = await Promise.all([
      queue.enqueue(makeRequest(1)),
      queue.enqueue(makeRequest(2)),
      queue.enqueue(makeRequest(3)),
    ]);

    // 所有请求都应该成功
    expect(results).toHaveLength(3);
    results.forEach((r) => expect(r.success).toBe(true));

    // 应该按顺序处理
    expect(order).toEqual([1, 2, 3]);
  });

  it('处理失败应该 reject 对应的 Promise', async () => {
    const handler = async (_request: CodeChangeRequest): Promise<ModificationResult> => {
      throw new Error('模拟失败');
    };

    const queue = new ModificationQueue(handler);
    const request: CodeChangeRequest = {
      intent: 'modify',
      targetFile: 'test.ts',
      description: 'will fail',
      operator: { type: 'user' },
      rawMessage: 'test',
    };

    await expect(queue.enqueue(request)).rejects.toThrow('模拟失败');
  });
});
