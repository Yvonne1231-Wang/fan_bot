// ─── Rollback Manager Tests ─────────────────────────────────────────────────
// 这些测试需要 git init 能力，在某些沙箱环境（如 Mira agent）中不可用
// 本地开发和 CI 环境可正常运行

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { RollbackManager } from '../rollback.js';

const TEST_TMP_BASE = resolve(import.meta.dirname ?? process.cwd(), '../../../.test-tmp');
const gitEnv = { ...process.env, GIT_TEMPLATE_DIR: '' };

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe', env: gitEnv });
}

function makeTmpDir(): string {
  const dir = join(TEST_TMP_BASE, `rollback-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 检测 git init 是否可用 */
function canGitInit(): boolean {
  const testDir = join(TEST_TMP_BASE, '_git-probe');
  try {
    mkdirSync(testDir, { recursive: true });
    git('git init', testDir);
    rmSync(testDir, { recursive: true, force: true });
    return true;
  } catch {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return false;
  }
}

const GIT_AVAILABLE = canGitInit();

describe.skipIf(!GIT_AVAILABLE)('RollbackManager', () => {
  let workDir: string;
  let manager: RollbackManager;

  beforeEach(() => {
    workDir = makeTmpDir();
    git('git init', workDir);
    git('git config user.email "test@test.com"', workDir);
    git('git config user.name "Test"', workDir);

    writeFileSync(join(workDir, 'init.txt'), 'initial');
    git('git add -A && git commit -m "initial"', workDir);
    git('git branch -M main', workDir);

    manager = new RollbackManager({ workDir, mainBranch: 'main' });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    try {
      if (existsSync(TEST_TMP_BASE)) {
        rmSync(TEST_TMP_BASE, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  });

  it('空仓库应该返回空版本列表', () => {
    const versions = manager.listVersions();
    expect(versions).toHaveLength(0);
  });

  it('应该列出 v-auto-* 标签', () => {
    writeFileSync(join(workDir, 'v1.txt'), 'version 1');
    git('git add -A && git commit -m "v1"', workDir);
    git('git tag v-auto-1000', workDir);

    writeFileSync(join(workDir, 'v2.txt'), 'version 2');
    git('git add -A && git commit -m "v2"', workDir);
    git('git tag v-auto-2000', workDir);

    const versions = manager.listVersions();
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[0].tag).toBe('v-auto-2000');
  });

  it('应该获取当前版本信息', () => {
    git('git tag v-auto-test', workDir);
    const current = manager.currentVersion();
    expect(current.hash).toBeTruthy();
    expect(current.tag).toBe('v-auto-test');
  });

  it('应该能回退到指定 tag', async () => {
    writeFileSync(join(workDir, 'v1.txt'), 'version 1');
    git('git add -A && git commit -m "v1"', workDir);
    git('git tag v-auto-v1', workDir);

    writeFileSync(join(workDir, 'v2.txt'), 'version 2');
    git('git add -A && git commit -m "v2"', workDir);
    git('git tag v-auto-v2', workDir);

    const operator = { type: 'user' as const, userName: 'Test' };
    const result = await manager.rollback('v-auto-v1', operator, '/rollback v-auto-v1');

    expect(result.success).toBe(true);
    expect(result.tag).toContain('v-auto-rollback');
  });

  it('回退到不存在的目标应该失败', async () => {
    const operator = { type: 'user' as const, userName: 'Test' };
    const result = await manager.rollback('nonexistent-tag', operator, '/rollback bad');
    expect(result.success).toBe(false);
    expect(result.error).toContain('无法解析');
  });

  it('格式化版本列表', () => {
    const formatted = manager.formatVersionList([]);
    expect(formatted).toBe('暂无自动修改版本记录');
  });
});
