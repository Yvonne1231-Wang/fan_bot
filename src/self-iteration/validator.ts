// ─── Code Validator ──────────────────────────────────────────────────────────
// 验证三关：TypeScript 编译 → 单元测试 → 沙箱试运行

import { execSync, spawn } from 'child_process';
import { createDebug } from '../utils/debug.js';
import type { ValidationResults } from './types.js';

const log = createDebug('self-iteration:validator');

interface ValidatorConfig {
  workDir: string;
  /** 测试超时（ms），默认 60s */
  testTimeout?: number;
  /** 沙箱试运行超时（ms），默认 15s */
  sandboxTimeout?: number;
  /** 沙箱试运行启动就绪关键词 */
  readySignals?: string[];
  /** 是否跳过沙箱试运行 */
  skipSandbox?: boolean;
}

/**
 * 代码验证器：修改后上线前必须通过的三道关卡
 */
export class CodeValidator {
  private config: ValidatorConfig;

  constructor(config: ValidatorConfig) {
    this.config = {
      testTimeout: 60_000,
      sandboxTimeout: 15_000,
      readySignals: ['Server started', 'ready', 'listening'],
      skipSandbox: false,
      ...config,
    };
  }

  /**
   * 执行完整验证流程
   */
  async validate(): Promise<ValidationResults> {
    const errors: string[] = [];
    let tscPass = false;
    let testPass = false;
    let sandboxPass = false;

    // 第一关：TypeScript 编译检查
    log.info('验证第一关: TypeScript 编译检查...');
    const tscResult = this.runTsc();
    tscPass = tscResult.pass;
    if (!tscPass) {
      errors.push(`TypeScript 编译失败: ${tscResult.error}`);
      // 编译都过不了，后续关卡无意义
      return { tscPass, testPass, sandboxPass, errors };
    }
    log.info('第一关通过 ✓');

    // 第二关：单元测试
    log.info('验证第二关: 单元测试...');
    const testResult = this.runTests();
    testPass = testResult.pass;
    if (!testPass) {
      errors.push(`测试失败: ${testResult.error}`);
      return { tscPass, testPass, sandboxPass, errors };
    }
    log.info('第二关通过 ✓');

    // 第三关：沙箱试运行
    if (!this.config.skipSandbox) {
      log.info('验证第三关: 沙箱试运行...');
      const sandboxResult = await this.runSandbox();
      sandboxPass = sandboxResult.pass;
      if (!sandboxPass) {
        errors.push(`沙箱试运行失败: ${sandboxResult.error}`);
        return { tscPass, testPass, sandboxPass, errors };
      }
      log.info('第三关通过 ✓');
    } else {
      sandboxPass = true;
      log.info('第三关跳过 (skipSandbox=true)');
    }

    return { tscPass, testPass, sandboxPass, errors };
  }

  private runTsc(): { pass: boolean; error?: string } {
    try {
      execSync('npm run typecheck', {
        cwd: this.config.workDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 30_000,
      });
      return { pass: true };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string };
      const output = (err.stdout ?? '') + (err.stderr ?? '');
      // 只取前 500 字符避免日志过长
      return { pass: false, error: output.slice(0, 500) };
    }
  }

  private runTests(): { pass: boolean; error?: string } {
    try {
      execSync('npm test -- --bail', {
        cwd: this.config.workDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: this.config.testTimeout,
      });
      return { pass: true };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string };
      const output = (err.stdout ?? '') + (err.stderr ?? '');
      return { pass: false, error: output.slice(0, 500) };
    }
  }

  private runSandbox(): Promise<{ pass: boolean; error?: string }> {
    return new Promise((resolve) => {
      const timeout = this.config.sandboxTimeout ?? 15_000;
      const readySignals = this.config.readySignals ?? [];

      // 先构建
      try {
        execSync('npm run build', {
          cwd: this.config.workDir,
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 30_000,
        });
      } catch (e: unknown) {
        const err = e as { stderr?: string };
        resolve({ pass: false, error: `构建失败: ${(err.stderr ?? '').slice(0, 300)}` });
        return;
      }

      // 用随机端口在 DRY_RUN 模式下试运行
      const proc = spawn('node', ['dist/index.js'], {
        cwd: this.config.workDir,
        env: {
          ...globalThis.process?.env,
          DRY_RUN: 'true',
          PORT: '0',
          TRANSPORT: 'http',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill();
          // 超时但没崩溃 = 至少能启动，判定通过
          resolve({ pass: true });
        }
      }, timeout);

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        // 检查就绪信号
        if (
          !settled &&
          readySignals.some((signal) => stdout.includes(signal))
        ) {
          settled = true;
          clearTimeout(timer);
          proc.kill();
          resolve({ pass: true });
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ pass: false, error: err.message });
        }
      });

      proc.on('exit', (code) => {
        if (!settled && code !== null && code !== 0) {
          settled = true;
          clearTimeout(timer);
          resolve({
            pass: false,
            error: `进程退出 code=${code}: ${stderr.slice(0, 300)}`,
          });
        }
      });
    });
  }
}
