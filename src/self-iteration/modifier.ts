// ─── Safe Code Modifier ─────────────────────────────────────────────────────
// 核心模块：在隔离 Git 分支上执行修改，验证通过后合并到主分支

import { execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createDebug } from '../utils/debug.js';
import { isPathAllowed, checkModificationScope, scanCode, DEFAULT_POLICY } from './policy.js';
import { CheckpointManager } from './checkpoint.js';
import { ModificationLock } from './lock.js';
import { AuditLogger } from './audit.js';
import { CodeValidator } from './validator.js';
import type {
  CodeChangeRequest,
  ModificationResult,
  ModificationPolicy,
} from './types.js';

const log = createDebug('self-iteration:modifier');

interface SafeCodeModifierConfig {
  workDir: string;
  /** 主分支名称，默认 main */
  mainBranch?: string;
  /** 修改策略 */
  policy?: ModificationPolicy;
  /** 日志目录 */
  logDir?: string;
  /** 是否跳过沙箱验证 */
  skipSandbox?: boolean;
  /** 写入文件的回调（由 LLM 调用层提供） */
  writeFile?: (filePath: string, content: string) => Promise<void>;
}

/**
 * 安全代码修改器
 *
 * 完整流程：
 * 获取锁 → 创建分支 → 修改代码 → 安全扫描 → 验证三关 → 合并 → 打 tag → 审计日志
 *
 * 每一步都有 checkpoint，崩溃后可恢复
 */
export class SafeCodeModifier {
  private config: Required<
    Pick<SafeCodeModifierConfig, 'workDir' | 'mainBranch' | 'policy'>
  > &
    SafeCodeModifierConfig;
  private lock: ModificationLock;
  private checkpoint: CheckpointManager;
  private audit: AuditLogger;
  private validator: CodeValidator;

  constructor(config: SafeCodeModifierConfig) {
    this.config = {
      mainBranch: 'main',
      policy: DEFAULT_POLICY,
      logDir: `${config.workDir}/logs`,
      ...config,
    };
    this.lock = new ModificationLock(config.workDir);
    this.checkpoint = new CheckpointManager(config.workDir);
    this.audit = new AuditLogger(this.config.logDir ?? `${config.workDir}/logs`);
    this.validator = new CodeValidator({
      workDir: config.workDir,
      skipSandbox: config.skipSandbox,
    });
  }

  /**
   * 启动时调用：从断点恢复
   */
  async recover(): Promise<void> {
    const result = await this.checkpoint.recover();
    if (result.recovered) {
      log.warn(`断点恢复完成: ${result.action}`);
    }
  }

  /**
   * 执行一次安全的代码修改
   *
   * 副作用：
   * - 创建/删除 Git 分支
   * - 修改文件内容
   * - 创建 Git commit 和 tag
   * - 写入审计日志和 checkpoint 文件
   * - 获取/释放文件锁
   */
  async applyChange(
    request: CodeChangeRequest,
    codeChanges: Array<{ filePath: string; content: string }>,
  ): Promise<ModificationResult> {
    const requestId = randomUUID();
    const startTime = Date.now();
    const branch = `auto/modify-${Date.now()}`;

    // 1. 获取锁
    const lockResult = this.lock.acquire(
      request.operator.userName ?? request.operator.type,
      requestId,
    );
    if (!lockResult.acquired) {
      const result: ModificationResult = {
        success: false,
        branch: '',
        commitHash: '',
        error: `修改被锁定，当前由 ${lockResult.heldBy} 持有`,
        duration: Date.now() - startTime,
      };
      this.logAudit(request, result);
      return result;
    }

    try {
      // 2. 安全检查：文件路径
      for (const change of codeChanges) {
        const pathCheck = isPathAllowed(change.filePath, this.config.policy);
        if (!pathCheck.allowed) {
          return this.fail(request, startTime, branch, pathCheck.reason ?? '路径不允许');
        }
      }

      // 3. 安全检查：修改范围
      const totalLines = codeChanges.reduce(
        (sum, c) => sum + c.content.split('\n').length,
        0,
      );
      const scopeCheck = checkModificationScope(
        codeChanges.map((c) => c.filePath),
        totalLines,
        this.config.policy,
      );
      if (!scopeCheck.allowed) {
        return this.fail(request, startTime, branch, scopeCheck.reason ?? '范围超限');
      }

      // 4. 安全检查：代码内容
      for (const change of codeChanges) {
        const scanResult = scanCode(change.content, change.filePath);
        if (!scanResult.safe) {
          const violations = scanResult.violations
            .map((v) => v.description)
            .join('; ');
          return this.fail(
            request,
            startTime,
            branch,
            `代码安全扫描未通过: ${violations}`,
          );
        }
      }

      // 5. 创建隔离分支
      this.checkpoint.save(requestId, 'branch_created', request, { branch });
      this.exec(`git checkout -b ${branch}`);

      // 6. 写入修改
      for (const change of codeChanges) {
        if (this.config.writeFile) {
          await this.config.writeFile(change.filePath, change.content);
        } else {
          // 使用 fs 直接写（默认行为）
          const { writeFileSync } = await import('fs');
          const { dirname } = await import('path');
          const { mkdirSync, existsSync } = await import('fs');
          const dir = dirname(`${this.config.workDir}/${change.filePath}`);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(
            `${this.config.workDir}/${change.filePath}`,
            change.content,
          );
        }
      }

      this.checkpoint.save(requestId, 'code_modified', request, { branch });

      // 7. 提交
      this.exec('git add -A');
      this.exec(`git commit -m "auto: ${this.sanitizeCommitMessage(request.description)}"`);
      const commitHash = this.exec('git rev-parse HEAD').trim();

      // 8. 验证三关
      this.checkpoint.save(requestId, 'validation_started', request, {
        branch,
        commitHash,
      });
      log.info('开始验证三关...');
      const validationResults = await this.validator.validate();

      if (!validationResults.tscPass || !validationResults.testPass || !validationResults.sandboxPass) {
        // 验证失败：清理分支
        this.exec(`git checkout ${this.config.mainBranch}`);
        this.safeExec(`git branch -D ${branch}`);
        return this.fail(
          request,
          startTime,
          branch,
          `验证未通过: ${validationResults.errors.join('; ')}`,
          validationResults,
        );
      }

      this.checkpoint.save(requestId, 'validation_passed', request, {
        branch,
        commitHash,
      });

      // 9. 合并到主分支
      this.exec(`git checkout ${this.config.mainBranch}`);
      this.exec(`git merge ${branch} --no-ff -m "auto-merge: ${request.description}"`);
      const tag = `v-auto-${Date.now()}`;
      this.exec(`git tag ${tag}`);

      this.checkpoint.save(requestId, 'merged', request, {
        branch,
        commitHash,
      });

      // 10. 清理临时分支
      this.safeExec(`git branch -d ${branch}`);

      // 10.5 Build & deferred restart
      this.checkpoint.save(requestId, 'build_started', request, {
        branch,
        commitHash,
      });
      log.info('开始 build...');
      this.exec('npm run build');

      // 11. 完成：先清理 checkpoint、写审计日志、组装返回值
      //     然后再调度延迟重启（解决 pm2 restart 自杀问题）
      this.checkpoint.clear();

      const result: ModificationResult = {
        success: true,
        branch,
        commitHash,
        tag,
        validationResults,
        duration: Date.now() - startTime,
      };

      this.logAudit(request, result);
      log.info(`修改完成 ✓ tag=${tag} (${result.duration}ms)`);

      // 12. 延迟重启：spawn 一个 detached 子进程，等待 2 秒后执行 pm2 restart
      //     当前进程不持有该子进程引用，因此 pm2 restart 杀掉当前进程时
      //     checkpoint 和审计日志已经全部落盘
      this.scheduleRestart();

      return result;
    } catch (err) {
      // 异常兜底：回到主分支
      this.safeExec(`git checkout ${this.config.mainBranch}`);
      this.safeExec(`git branch -D ${branch}`);
      this.checkpoint.clear();

      const result: ModificationResult = {
        success: false,
        branch,
        commitHash: '',
        error: (err as Error).message,
        duration: Date.now() - startTime,
      };
      this.logAudit(request, result);
      return result;
    } finally {
      this.lock.release();
    }
  }

  /**
   * 获取审计日志实例（供外部查询）
   */
  getAuditLogger(): AuditLogger {
    return this.audit;
  }

  /**
   * 延迟重启 pm2 服务
   *
   * 原理：spawn 一个 detached 子进程执行 `sleep 2 && pm2 restart fan_bot`
   * - detached: 子进程独立于当前进程组，不受当前进程退出影响
   * - unref(): 当前进程不等待子进程，event loop 不阻塞
   * - stdio: ignore，不继承当前进程的 fd
   *
   * 这样当前进程可以先完成 checkpoint.clear()、审计日志写入、
   * 返回结果给调用方，2 秒后子进程才执行 pm2 restart
   */
  private scheduleRestart(): void {
    log.info('调度延迟重启: 2 秒后执行 pm2 restart fan_bot ...');
    const child = spawn('sh', ['-c', 'sleep 2 && pm2 restart fan_bot'], {
      cwd: this.config.workDir,
      detached: true,
      stdio: 'ignore',
    });
    // 解除父进程对子进程的引用，允许父进程正常退出
    child.unref();
  }

  private fail(
    request: CodeChangeRequest,
    startTime: number,
    branch: string,
    error: string,
    validationResults?: ModificationResult['validationResults'],
  ): ModificationResult {
    const result: ModificationResult = {
      success: false,
      branch,
      commitHash: '',
      error,
      validationResults,
      duration: Date.now() - startTime,
    };
    this.logAudit(request, result);
    log.warn(`修改失败: ${error}`);
    return result;
  }

  private logAudit(
    request: CodeChangeRequest,
    result: ModificationResult,
  ): void {
    this.audit.log({
      operator: request.operator,
      action: request.intent === 'rollback' ? 'rollback' : 'modify',
      rawMessage: request.rawMessage,
      parsedIntent: `${request.intent} ${request.targetFile}`,
      targetFiles: [request.targetFile],
      success: result.success,
      commitHash: result.commitHash || undefined,
      tag: result.tag,
      error: result.error,
      validationResults: result.validationResults,
      duration: result.duration,
    });
  }

  /** 清理 commit message 中的特殊字符，防止 shell 注入 */
  private sanitizeCommitMessage(msg: string): string {
    return msg.replace(/["`$\\]/g, '').slice(0, 200);
  }

  private exec(cmd: string): string {
    return execSync(cmd, {
      cwd: this.config.workDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  }

  private safeExec(cmd: string): void {
    try {
      this.exec(cmd);
    } catch {
      log.warn(`命令执行失败（已忽略）: ${cmd}`);
    }
  }
}
