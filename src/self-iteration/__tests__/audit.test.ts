// ─── Audit Logger Tests ─────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLogger } from '../audit.js';

describe('AuditLogger', () => {
  let logDir: string;
  let logger: AuditLogger;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'audit-test-'));
    logger = new AuditLogger(logDir);
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it('应该创建审计日志文件并写入记录', () => {
    const entry = logger.log({
      operator: { type: 'user', userId: 'u1', userName: 'Alice' },
      action: 'modify',
      rawMessage: '/modify src/test.ts add hello',
      parsedIntent: 'modify src/test.ts',
      targetFiles: ['src/test.ts'],
      success: true,
      commitHash: 'abc123',
      tag: 'v-auto-123',
      duration: 1500,
    });

    expect(entry.id).toBeTruthy();
    expect(entry.operator.userName).toBe('Alice');
    expect(entry.result.success).toBe(true);

    const logPath = join(logDir, 'self-iteration-audit.jsonl');
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe(entry.id);
  });

  it('应该支持查询最近 N 条记录', () => {
    for (let i = 0; i < 5; i++) {
      logger.log({
        operator: { type: 'user', userId: `u${i}` },
        action: 'modify',
        rawMessage: `msg-${i}`,
        parsedIntent: `intent-${i}`,
        targetFiles: [`file-${i}.ts`],
        success: i % 2 === 0,
        duration: i * 100,
      });
    }

    const recent = logger.recent(3);
    expect(recent).toHaveLength(3);
    // 最后 3 条是 index 2, 3, 4
    expect(recent[0].request.rawMessage).toBe('msg-2');
    expect(recent[2].request.rawMessage).toBe('msg-4');
  });

  it('应该正确格式化审计记录', () => {
    logger.log({
      operator: { type: 'user', userName: 'Bob' },
      action: 'rollback',
      rawMessage: '/rollback last',
      parsedIntent: 'rollback',
      targetFiles: ['*'],
      success: false,
      error: '找不到目标版本',
      duration: 200,
    });

    const entries = logger.recent(10);
    const formatted = logger.formatEntries(entries);
    expect(formatted).toContain('Bob');
    expect(formatted).toContain('rollback');
    expect(formatted).toContain('✗');
    expect(formatted).toContain('找不到目标版本');
  });

  it('空记录应该返回提示文本', () => {
    const formatted = logger.formatEntries([]);
    expect(formatted).toBe('暂无变更记录');
  });
});
