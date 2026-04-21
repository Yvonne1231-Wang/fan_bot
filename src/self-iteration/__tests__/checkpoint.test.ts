// ─── Checkpoint Manager Tests ───────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CheckpointManager } from '../checkpoint.js';
import type { CodeChangeRequest } from '../types.js';

describe('CheckpointManager', () => {
  let workDir: string;
  let cp: CheckpointManager;

  const mockRequest: CodeChangeRequest = {
    intent: 'modify',
    targetFile: 'src/test.ts',
    description: 'test modification',
    operator: { type: 'user', userId: 'u1', userName: 'Alice' },
    rawMessage: '/modify src/test.ts',
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'checkpoint-test-'));
    cp = new CheckpointManager(workDir);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('初始状态应该没有 checkpoint', () => {
    expect(cp.load()).toBeNull();
  });

  it('应该能保存和加载 checkpoint', () => {
    cp.save('req-1', 'branch_created', mockRequest, { branch: 'auto/test-123' });

    const loaded = cp.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('req-1');
    expect(loaded!.state).toBe('branch_created');
    expect(loaded!.branch).toBe('auto/test-123');
    expect(loaded!.request.targetFile).toBe('src/test.ts');
  });

  it('应该能更新状态并保留 startedAt', () => {
    cp.save('req-1', 'branch_created', mockRequest);
    const first = cp.load()!;

    // 稍等一下让时间不同
    cp.save('req-1', 'code_modified', mockRequest, { branch: 'auto/test' });
    const second = cp.load()!;

    expect(second.state).toBe('code_modified');
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  it('clear 应该删除 checkpoint 文件', () => {
    cp.save('req-1', 'branch_created', mockRequest);
    expect(cp.load()).not.toBeNull();

    cp.clear();
    expect(cp.load()).toBeNull();
  });

  it('recover 在无 checkpoint 时应该返回 not recovered', async () => {
    const result = await cp.recover();
    expect(result.recovered).toBe(false);
    expect(result.action).toBe('none');
  });

  // 注意：recover 的 git 操作测试需要真实的 git repo，这里只测试无 checkpoint 的场景
});
