// ─── Self-Iteration Entry Point ─────────────────────────────────────────────
// 统一入口：组装所有模块，暴露简洁 API 给上层调用

import { createDebug } from '../utils/debug.js';
import { SafeCodeModifier } from './modifier.js';
import { RollbackManager } from './rollback.js';
import { ModificationQueue } from './lock.js';
import { DEFAULT_POLICY } from './policy.js';
import type {
  CodeChangeRequest,
  ModificationResult,
  ModificationPolicy,
  OperatorInfo,
  VersionInfo,
} from './types.js';

const log = createDebug('self-iteration');

// ─── Configuration ──────────────────────────────────────────────────────────

export interface SelfIterationConfig {
  /** 项目根目录（包含 .git） */
  workDir: string;
  /** 主分支名称，默认 main */
  mainBranch?: string;
  /** 修改策略 */
  policy?: ModificationPolicy;
  /** 日志目录 */
  logDir?: string;
  /** 是否跳过沙箱试运行 */
  skipSandbox?: boolean;
  /** 写入文件回调 */
  writeFile?: (filePath: string, content: string) => Promise<void>;
}

// ─── Facade ─────────────────────────────────────────────────────────────────

/**
 * 自迭代系统门面
 *
 * 使用方式:
 * ```ts
 * const si = createSelfIteration({ workDir: '/path/to/project' });
 * await si.initialize();
 *
 * // 修改代码
 * const result = await si.modify(request, codeChanges);
 *
 * // 回退
 * const rollbackResult = await si.rollback('last', operator, '回退到上一版本');
 *
 * // 查询历史
 * const versions = si.listVersions();
 * const auditLogs = si.recentAuditLogs(10);
 * ```
 */
export interface SelfIteration {
  /** 初始化：断点恢复 */
  initialize(): Promise<void>;

  /** 提交代码修改请求（自动排队） */
  modify(
    request: CodeChangeRequest,
    codeChanges: Array<{ filePath: string; content: string }>,
  ): Promise<ModificationResult>;

  /** 回退到指定版本 */
  rollback(
    target: string,
    operator: OperatorInfo,
    rawMessage: string,
  ): Promise<ModificationResult>;

  /** 列出历史版本 */
  listVersions(limit?: number): VersionInfo[];

  /** 格式化版本列表 */
  formatVersionList(versions: VersionInfo[]): string;

  /** 获取最近审计日志 */
  recentAuditLogs(count: number): import('./types.js').AuditEntry[];

  /** 格式化审计日志 */
  formatAuditLogs(count: number): string;
}

// ─── Implementation ─────────────────────────────────────────────────────────

class SelfIterationImpl implements SelfIteration {
  private modifier: SafeCodeModifier;
  private rollbackManager: RollbackManager;
  private queue: ModificationQueue;

  constructor(config: SelfIterationConfig) {
    const mergedConfig = {
      mainBranch: 'main',
      policy: DEFAULT_POLICY,
      logDir: `${config.workDir}/logs`,
      ...config,
    };

    this.modifier = new SafeCodeModifier(mergedConfig);
    this.rollbackManager = new RollbackManager(mergedConfig);

    // 队列处理器：将排队的请求交给 modifier 处理
    // 注意：队列只处理 modify 请求，rollback 直接执行
    this.queue = new ModificationQueue(async (request) => {
      // 从队列中取出时，codeChanges 挂在 request._codeChanges 上
      const codeChanges = (request as CodeChangeRequest & { _codeChanges: Array<{ filePath: string; content: string }> })._codeChanges;
      return this.modifier.applyChange(request, codeChanges);
    });
  }

  async initialize(): Promise<void> {
    log.info('自迭代系统初始化...');
    await this.modifier.recover();
    log.info('自迭代系统就绪');
  }

  async modify(
    request: CodeChangeRequest,
    codeChanges: Array<{ filePath: string; content: string }>,
  ): Promise<ModificationResult> {
    // 将 codeChanges 附加到 request 上，通过队列传递
    const enrichedRequest = Object.assign({}, request, { _codeChanges: codeChanges });
    return this.queue.enqueue(enrichedRequest);
  }

  async rollback(
    target: string,
    operator: OperatorInfo,
    rawMessage: string,
  ): Promise<ModificationResult> {
    return this.rollbackManager.rollback(target, operator, rawMessage);
  }

  listVersions(limit?: number): VersionInfo[] {
    return this.rollbackManager.listVersions(limit);
  }

  formatVersionList(versions: VersionInfo[]): string {
    return this.rollbackManager.formatVersionList(versions);
  }

  recentAuditLogs(count: number): import('./types.js').AuditEntry[] {
    return this.modifier.getAuditLogger().recent(count);
  }

  formatAuditLogs(count: number): string {
    const entries = this.recentAuditLogs(count);
    return this.modifier.getAuditLogger().formatEntries(entries);
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * 创建自迭代系统实例
 *
 * @example
 * ```ts
 * import { createSelfIteration } from './self-iteration/index.js';
 *
 * const si = createSelfIteration({
 *   workDir: process.cwd(),
 *   skipSandbox: process.env.NODE_ENV === 'development',
 * });
 *
 * await si.initialize();
 * ```
 */
export function createSelfIteration(config: SelfIterationConfig): SelfIteration {
  return new SelfIterationImpl(config);
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export type {
  CodeChangeRequest,
  ModificationResult,
  ModificationPolicy,
  OperatorInfo,
  VersionInfo,
  ModificationState,
  ModificationCheckpoint,
  AuditEntry,
  RiskAssessment,
  ValidationResults,
} from './types.js';

export { DEFAULT_POLICY, isPathAllowed, checkModificationScope, scanCode } from './policy.js';
export { SafeCodeModifier } from './modifier.js';
export { RollbackManager } from './rollback.js';
export { AuditLogger } from './audit.js';
export { ModificationLock, ModificationQueue } from './lock.js';
export { CheckpointManager } from './checkpoint.js';
export { CodeValidator } from './validator.js';
