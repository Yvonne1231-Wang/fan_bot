// ─── Rollback Manager ───────────────────────────────────────────────────────
// 版本回退：列出历史版本、回退到指定版本

import { execSync } from 'child_process';
import { createDebug } from '../utils/debug.js';
import { AuditLogger } from './audit.js';
import type {
  CodeChangeRequest,
  ModificationResult,
  OperatorInfo,
  VersionInfo,
} from './types.js';

const log = createDebug('self-iteration:rollback');

interface RollbackManagerConfig {
  workDir: string;
  mainBranch?: string;
  logDir?: string;
}

/**
 * 版本回退管理器
 *
 * 支持：
 * - 列出所有自动版本 (v-auto-* tags)
 * - 回退到指定 tag 或 commit hash
 * - "last" 快捷回退到上一个版本
 */
export class RollbackManager {
  private workDir: string;
  private mainBranch: string;
  private audit: AuditLogger;

  constructor(config: RollbackManagerConfig) {
    this.workDir = config.workDir;
    this.mainBranch = config.mainBranch ?? 'main';
    this.audit = new AuditLogger(config.logDir ?? `${config.workDir}/logs`);
  }

  /**
   * 列出所有自动生成的版本标签
   * 按时间倒序排列，最新的在前
   */
  listVersions(limit = 20): VersionInfo[] {
    try {
      // 获取 v-auto-* 标签，按创建时间倒序
      const output = this.exec(
        `git tag -l "v-auto-*" --sort=-creatordate --format="%(refname:short)|%(objectname:short)|%(creatordate:iso-strict)|%(subject)"`,
      );

      if (!output.trim()) return [];

      return output
        .trim()
        .split('\n')
        .slice(0, limit)
        .map((line) => {
          const [tag, hash, date, ...messageParts] = line.split('|');
          return {
            tag: tag ?? '',
            hash: hash ?? '',
            date: date ?? '',
            message: messageParts.join('|') || '(no message)',
          };
        });
    } catch (err) {
      log.error(`列出版本失败: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * 获取当前所在版本信息
   */
  currentVersion(): { hash: string; tag?: string } {
    const hash = this.exec('git rev-parse HEAD').trim();
    // 检查 HEAD 是否有 tag
    try {
      const tag = this.exec('git describe --tags --exact-match HEAD 2>/dev/null').trim();
      return { hash, tag: tag || undefined };
    } catch {
      return { hash };
    }
  }

  /**
   * 回退到指定版本
   *
   * @param target - tag 名称、commit hash、或 "last"（上一个 v-auto-* tag）
   * @param operator - 操作者信息
   * @returns 修改结果
   */
  async rollback(
    target: string,
    operator: OperatorInfo,
    rawMessage: string,
  ): Promise<ModificationResult> {
    const startTime = Date.now();

    try {
      // 解析目标
      const resolvedTarget = this.resolveTarget(target);
      if (!resolvedTarget) {
        return this.fail(startTime, operator, rawMessage, `无法解析回退目标: "${target}"`);
      }

      log.info(`开始回退到: ${resolvedTarget.tag ?? resolvedTarget.hash}`);

      // 确保在主分支上
      const currentBranch = this.exec('git branch --show-current').trim();
      if (currentBranch !== this.mainBranch) {
        this.exec(`git checkout ${this.mainBranch}`);
      }

      // 检查工作区是否干净
      const status = this.exec('git status --porcelain').trim();
      if (status) {
        return this.fail(
          startTime,
          operator,
          rawMessage,
          '工作区有未提交的修改，请先处理后再回退',
        );
      }

      // 执行回退（使用 git revert 而非 reset，保留历史）
      const targetHash = resolvedTarget.hash;
      const currentHash = this.exec('git rev-parse HEAD').trim();

      if (targetHash === currentHash) {
        return this.fail(startTime, operator, rawMessage, '已在目标版本上，无需回退');
      }

      // 使用 reset --hard 回退到目标版本（在自动修改场景下更直观）
      // 创建回退前的安全标记
      const safetyTag = `v-before-rollback-${Date.now()}`;
      this.exec(`git tag ${safetyTag}`);
      log.info(`安全标记已创建: ${safetyTag}`);

      // 执行硬回退
      this.exec(`git reset --hard ${targetHash}`);

      // 创建回退标记
      const rollbackTag = `v-auto-rollback-${Date.now()}`;
      this.exec(`git tag ${rollbackTag}`);

      const result: ModificationResult = {
        success: true,
        branch: this.mainBranch,
        commitHash: targetHash,
        tag: rollbackTag,
        duration: Date.now() - startTime,
      };

      // 审计日志
      this.audit.log({
        operator,
        action: 'rollback',
        rawMessage,
        parsedIntent: `rollback to ${resolvedTarget.tag ?? resolvedTarget.hash}`,
        targetFiles: ['*'],
        success: true,
        commitHash: targetHash,
        tag: rollbackTag,
        duration: result.duration,
      });

      log.info(
        `回退成功 ✓ → ${resolvedTarget.tag ?? targetHash} (安全标记: ${safetyTag})`,
      );
      return result;
    } catch (err) {
      return this.fail(startTime, operator, rawMessage, (err as Error).message);
    }
  }

  /**
   * 格式化版本列表为可读文本（用于飞书回复）
   */
  formatVersionList(versions: VersionInfo[]): string {
    if (versions.length === 0) return '暂无自动修改版本记录';

    const current = this.currentVersion();
    return versions
      .map((v, i) => {
        const isCurrent = v.hash === current.hash.slice(0, 7) || v.tag === current.tag;
        const marker = isCurrent ? ' ← 当前' : '';
        const date = v.date.replace('T', ' ').slice(0, 19);
        return `${i + 1}. **${v.tag}** (${v.hash}) [${date}]${marker}\n   ${v.message}`;
      })
      .join('\n');
  }

  /**
   * 解析回退目标
   */
  private resolveTarget(
    target: string,
  ): { hash: string; tag?: string } | null {
    // "last" → 上一个 v-auto-* 标签
    if (target === 'last' || target === '上一个' || target === '上个版本') {
      const versions = this.listVersions(2);
      const current = this.currentVersion();

      // 找到当前之前的那个版本
      const prev = versions.find(
        (v) => v.hash !== current.hash.slice(0, v.hash.length),
      );
      if (!prev) {
        log.warn('找不到上一个版本');
        return null;
      }
      return { hash: this.resolveFullHash(prev.hash), tag: prev.tag };
    }

    // tag 名称
    if (target.startsWith('v-auto')) {
      try {
        const hash = this.exec(`git rev-parse "${target}"`).trim();
        return { hash, tag: target };
      } catch {
        return null;
      }
    }

    // commit hash（短或长）
    try {
      const hash = this.exec(`git rev-parse "${target}"`).trim();
      return { hash };
    } catch {
      return null;
    }
  }

  private resolveFullHash(shortHash: string): string {
    return this.exec(`git rev-parse "${shortHash}"`).trim();
  }

  private fail(
    startTime: number,
    operator: OperatorInfo,
    rawMessage: string,
    error: string,
  ): ModificationResult {
    log.warn(`回退失败: ${error}`);
    this.audit.log({
      operator,
      action: 'rollback',
      rawMessage,
      parsedIntent: `rollback (failed)`,
      targetFiles: ['*'],
      success: false,
      error,
      duration: Date.now() - startTime,
    });
    return {
      success: false,
      branch: this.mainBranch,
      commitHash: '',
      error,
      duration: Date.now() - startTime,
    };
  }

  private exec(cmd: string): string {
    return execSync(cmd, {
      cwd: this.workDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  }
}
