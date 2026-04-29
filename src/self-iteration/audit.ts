// ─── Audit Logger ───────────────────────────────────────────────────────────
// 结构化审计日志：记录谁在什么时间通过什么指令触发了什么修改

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { createDebug } from '../utils/debug.js';
import type { AuditEntry, OperatorInfo, ValidationResults } from './types.js';

const log = createDebug('self-iteration:audit');

export class AuditLogger {
  private logPath: string;

  constructor(logDir: string) {
    this.logPath = `${logDir}/self-iteration-audit.jsonl`;
    const dir = dirname(this.logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 创建一条审计记录
   * 副作用：追加写入 JSONL 文件
   */
  log(params: {
    operator: OperatorInfo;
    action: AuditEntry['action'];
    rawMessage: string;
    parsedIntent: string;
    targetFiles: string[];
    success: boolean;
    commitHash?: string;
    tag?: string;
    error?: string;
    validationResults?: ValidationResults;
    duration: number;
  }): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      operator: params.operator,
      action: params.action,
      request: {
        rawMessage: params.rawMessage,
        parsedIntent: params.parsedIntent,
        targetFiles: params.targetFiles,
      },
      result: {
        success: params.success,
        commitHash: params.commitHash,
        tag: params.tag,
        error: params.error,
        validationResults: params.validationResults,
      },
      duration: params.duration,
    };

    try {
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.logPath, line);
      log.info(`审计记录: ${entry.action} by ${entry.operator.userName ?? entry.operator.type} → ${entry.result.success ? '✓' : '✗'}`);
    } catch (err) {
      log.error(`写入审计日志失败: ${(err as Error).message}`);
    }

    return entry;
  }

  /**
   * 查询最近 N 条审计记录
   */
  recent(count: number): AuditEntry[] {
    if (!existsSync(this.logPath)) return [];

    try {
      const content = readFileSync(this.logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const recent = lines.slice(-count);
      return recent.map((line) => JSON.parse(line) as AuditEntry);
    } catch (err) {
      log.error(`读取审计日志失败: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * 格式化审计记录为可读文本（用于飞书 /audit 指令回复）
   */
  formatEntries(entries: AuditEntry[]): string {
    if (entries.length === 0) return '暂无变更记录';

    return entries
      .map((e, i) => {
        const time = e.timestamp.replace('T', ' ').slice(0, 19);
        const who = e.operator.userName ?? e.operator.type;
        const status = e.result.success ? '✓' : '✗';
        const files = e.request.targetFiles.join(', ');
        const duration = `${e.duration}ms`;
        const error = e.result.error ? ` (${e.result.error})` : '';
        return `${i + 1}. [${time}] ${who} → ${e.action} ${files} → ${status}${error} (${duration})`;
      })
      .join('\n');
  }
}
