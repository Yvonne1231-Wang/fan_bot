// ─── Checkpoint Manager ─────────────────────────────────────────────────────
// 状态持久化：修改流程中途崩溃后可从断点恢复

import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { createDebug } from '../utils/debug.js';
import type { ModificationCheckpoint, ModificationState, CodeChangeRequest } from './types.js';

const log = createDebug('self-iteration:checkpoint');

export class CheckpointManager {
  private filePath: string;
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
    this.filePath = `${workDir}/.self-iteration-checkpoint.json`;
  }

  /**
   * 保存当前修改流程的状态
   * 副作用：写入 checkpoint JSON 文件
   */
  save(
    id: string,
    state: ModificationState,
    request: CodeChangeRequest,
    extra?: { branch?: string; commitHash?: string; error?: string },
  ): void {
    const checkpoint: ModificationCheckpoint = {
      id,
      state,
      request,
      branch: extra?.branch,
      commitHash: extra?.commitHash,
      startedAt: this.load()?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: extra?.error,
    };

    writeFileSync(this.filePath, JSON.stringify(checkpoint, null, 2));
    log.debug(`Checkpoint 已保存: state=${state}`);
  }

  /**
   * 加载上次的 checkpoint
   */
  load(): ModificationCheckpoint | null {
    if (!existsSync(this.filePath)) return null;
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as ModificationCheckpoint;
    } catch {
      log.warn('Checkpoint 文件损坏');
      return null;
    }
  }

  /**
   * 清除 checkpoint（流程正常结束时调用）
   */
  clear(): void {
    if (existsSync(this.filePath)) {
      unlinkSync(this.filePath);
      log.debug('Checkpoint 已清除');
    }
  }

  /**
   * 从断点恢复：根据上次的状态决定下一步
   * - 中间状态（branch_created/code_modified/validation_started）→ 清理分支，重新开始
   * - validation_passed → 可继续合并
   * - merged → 可继续部署
   */
  async recover(): Promise<{ recovered: boolean; action: string }> {
    const cp = this.load();
    if (!cp || cp.state === 'idle') {
      return { recovered: false, action: 'none' };
    }

    log.warn(`发现未完成的修改流程: state=${cp.state}, branch=${cp.branch}`);

    switch (cp.state) {
      case 'branch_created':
      case 'code_modified':
      case 'validation_started':
      case 'failed': {
        // 中间状态或失败 → 回滚到 main，清理临时分支
        log.info('清理未完成的修改...');
        this.safeExec('git checkout main');
        if (cp.branch) {
          this.safeExec(`git branch -D ${cp.branch}`);
        }
        this.clear();
        return { recovered: true, action: `cleaned_up_branch_${cp.branch}` };
      }

      case 'validation_passed': {
        // 验证通过但未合并 → 清理（保守策略，不自动合并）
        log.info('验证已通过但未合并，清理分支（保守策略）');
        this.safeExec('git checkout main');
        if (cp.branch) {
          this.safeExec(`git branch -D ${cp.branch}`);
        }
        this.clear();
        return { recovered: true, action: 'cleaned_validated_but_unmerged' };
      }

      case 'merged':
      case 'build_started': {
        // 已合并但未部署 → 标记警告，让人工决定
        log.warn('已合并但未完成部署，需要人工检查');
        this.clear();
        return { recovered: true, action: 'merged_but_not_deployed' };
      }

      default: {
        this.clear();
        return { recovered: false, action: 'unknown_state_cleared' };
      }
    }
  }

  private safeExec(cmd: string): void {
    try {
      execSync(cmd, { cwd: this.workDir, encoding: 'utf-8', stdio: 'pipe' });
    } catch {
      log.warn(`命令执行失败（已忽略）: ${cmd}`);
    }
  }
}
