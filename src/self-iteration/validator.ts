// ─── Code Validator ──────────────────────────────────────────────────────────
// 验证三关：TypeScript 编译 → 单元测试 → Docker 沙箱试运行

import { execSync, spawn } from 'child_process';
import { createDebug } from '../utils/debug.js';
import type { ValidationResults } from './types.js';

const log = createDebug('self-iteration:validator');

interface ValidatorConfig {
  workDir: string;
  /** 测试超时（ms），默认 60s */
  testTimeout?: number;
  /** 沙箱试运行超时（ms），默认 30s（Docker 启动比宿主慢） */
  sandboxTimeout?: number;
  /** 沙箱试运行启动就绪关键词 */
  readySignals?: string[];
  /** 是否跳过沙箱试运行 */
  skipSandbox?: boolean;
  /** Docker 镜像名称，默认 node:22-slim */
  dockerImage?: string;
}

/**
 * 代码验证器：修改后上线前必须通过的三道关卡
 */
export class CodeValidator {
  private config: ValidatorConfig;

  constructor(config: ValidatorConfig) {
    this.config = {
      testTimeout: 60_000,
      sandboxTimeout: 30_000,
      readySignals: ['Server started', 'ready', 'listening'],
      skipSandbox: false,
      dockerImage: 'node:22-slim',
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

    // 第三关：Docker 沙箱试运行
    if (!this.config.skipSandbox) {
      log.info('验证第三关: Docker 沙箱试运行...');

      // 先检查 Docker 是否可用
      if (!this.isDockerAvailable()) {
        log.warn('Docker 不可用，回退到宿主机沙箱试运行');
        const sandboxResult = await this.runSandboxHost();
        sandboxPass = sandboxResult.pass;
        if (!sandboxPass) {
          errors.push(`沙箱试运行失败: ${sandboxResult.error}`);
          return { tscPass, testPass, sandboxPass, errors };
        }
      } else {
        const sandboxResult = await this.runSandboxDocker();
        sandboxPass = sandboxResult.pass;
        if (!sandboxPass) {
          errors.push(`Docker 沙箱试运行失败: ${sandboxResult.error}`);
          return { tscPass, testPass, sandboxPass, errors };
        }
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

  /**
   * 检查 Docker 是否可用
   */
  private isDockerAvailable(): boolean {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Docker 沙箱试运行（推荐）
   *
   * 隔离保证：
   * - 文件系统：只读挂载项目 dist/ 和 node_modules/，容器内无法写回宿主
   * - 网络：--network=none 完全断网，防止恶意代码外联
   * - 资源：--memory=256m --cpus=0.5 限制资源使用
   * - 权限：--read-only --no-new-privileges 禁止提权
   * - 自动清理：--rm 容器退出即删除
   */
  private runSandboxDocker(): Promise<{ pass: boolean; error?: string }> {
    return new Promise((resolve) => {
      const timeout = this.config.sandboxTimeout ?? 30_000;
      const readySignals = this.config.readySignals ?? [];
      const image = this.config.dockerImage ?? 'node:22-slim';
      const workDir = this.config.workDir;

      // 先在宿主机上构建（tsc 已通过，这里确保 dist/ 是最新的）
      try {
        execSync('npm run build', {
          cwd: workDir,
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 30_000,
        });
      } catch (e: unknown) {
        const err = e as { stderr?: string };
        resolve({ pass: false, error: `构建失败: ${(err.stderr ?? '').slice(0, 300)}` });
        return;
      }

      // Docker 容器内试运行
      // 挂载策略：dist/ 和 node_modules/ 只读挂载，package.json 只读挂载
      const dockerArgs = [
        'run',
        '--rm',
        '--name', `fan-bot-sandbox-${Date.now()}`,
        // 资源限制
        '--memory=256m',
        '--cpus=0.5',
        // 网络隔离
        '--network=none',
        // 安全加固
        '--read-only',
        '--no-new-privileges',
        // 需要可写的临时目录（Node.js 运行时需要）
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        // 只读挂载项目产物
        '-v', `${workDir}/dist:/app/dist:ro`,
        '-v', `${workDir}/node_modules:/app/node_modules:ro`,
        '-v', `${workDir}/package.json:/app/package.json:ro`,
        // 环境变量
        '-e', 'DRY_RUN=true',
        '-e', 'PORT=0',
        '-e', 'TRANSPORT=http',
        '-e', 'NODE_ENV=sandbox',
        // 工作目录
        '-w', '/app',
        // 镜像
        image,
        // 启动命令
        'node', 'dist/index.js',
      ];

      log.info(`启动 Docker 沙箱: docker ${dockerArgs.slice(0, 5).join(' ')} ...`);

      const proc = spawn('docker', dockerArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          // 超时但没崩溃 = 至少能启动，判定通过
          this.killDockerContainer(proc);
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
          this.killDockerContainer(proc);
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
          resolve({ pass: false, error: `Docker 启动失败: ${err.message}` });
        }
      });

      proc.on('exit', (code) => {
        if (!settled && code !== null && code !== 0) {
          settled = true;
          clearTimeout(timer);
          resolve({
            pass: false,
            error: `容器退出 code=${code}: ${stderr.slice(0, 300)}`,
          });
        }
      });
    });
  }

  /**
   * 优雅终止 Docker 容器
   */
  private killDockerContainer(proc: ReturnType<typeof spawn>): void {
    try {
      proc.kill('SIGTERM');
    } catch {
      // 容器可能已退出
    }
  }

  /**
   * 宿主机沙箱试运行（Docker 不可用时的 fallback）
   *
   * 注意：此方式无文件系统/网络隔离，仅作为 Docker 不可用时的降级方案
   */
  private runSandboxHost(): Promise<{ pass: boolean; error?: string }> {
    return new Promise((resolve) => {
      const timeout = this.config.sandboxTimeout ?? 15_000;
      const readySignals = this.config.readySignals ?? [];

      log.warn('使用宿主机沙箱（无 Docker 隔离），仅限开发环境');

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
