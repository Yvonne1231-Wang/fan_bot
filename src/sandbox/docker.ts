// ─── Docker Container Management ────────────────────────────────────────────

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import type { SandboxConfig, SandboxExecResult } from './types.js';
import { createDebug } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';

const execFileAsync = promisify(execFile);
const log = createDebug('sandbox:docker');

/** docker exec / docker create 返回的错误结构 */
interface DockerError extends Error {
  code?: number;
  stderr?: string;
}

/**
 * Docker 容器管理器
 *
 * 封装 docker CLI 操作，负责容器的创建、启动、执行、停止和删除。
 * 不包含业务逻辑，仅提供底层 Docker 操作。
 */
export class DockerManager {
  private readonly config: SandboxConfig;
  private containerId: string | null = null;

  constructor(config: SandboxConfig) {
    this.config = config;
  }

  /** 获取容器 ID（已创建后可用） */
  getContainerId(): string | null {
    return this.containerId;
  }

  /** 获取容器名称 */
  getContainerName(): string {
    return this.config.containerName;
  }

  /**
   * 检查 Docker daemon 是否可用
   *
   * 通过 `docker info` 验证 Docker 是否正常运行。
   */
  async isDockerAvailable(): Promise<boolean> {
    try {
      await this.runDocker(['info']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查指定镜像是否存在于本地
   */
  async imageExists(imageName: string): Promise<boolean> {
    try {
      await this.runDocker(['image', 'inspect', imageName]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查容器是否正在运行
   */
  async isContainerRunning(containerName: string): Promise<boolean> {
    try {
      const { stdout } = await this.runDocker([
        'inspect',
        '--format',
        '{{.State.Running}}',
        containerName,
      ]);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * 创建并启动沙箱容器
   *
   * 如果同名容器已存在且正在运行，则复用；
   * 如果已存在但已停止，则先删除再重新创建。
   *
   * @returns 容器 ID
   */
  async createAndStart(): Promise<string> {
    const name = this.config.containerName;

    const running = await this.isContainerRunning(name);
    if (running) {
      log.info(`Container "${name}" already running, reusing`);
      const { stdout } = await this.runDocker([
        'inspect',
        '--format',
        '{{.Id}}',
        name,
      ]);
      this.containerId = stdout.trim();
      return this.containerId;
    }

    try {
      await this.runDocker(['rm', '-f', name]);
      log.debug(`Removed existing stopped container "${name}"`);
    } catch {
      // 容器不存在，忽略
    }

    const hostWorkspace = resolve(this.config.hostWorkspacePath);

    const createArgs: string[] = [
      'create',
      '--name', name,
      '--network', this.config.network,
      `--memory=${this.config.memoryMB}m`,
      `--cpu-quota=${this.config.cpuQuota}`,
      '--pids-limit', '100',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--read-only',
      '--tmpfs', '/tmp:size=100m',
      '--tmpfs', '/run:size=10m',
      '--mount', `type=bind,source=${hostWorkspace},target=${this.config.workspacePath}`,
    ];

    if (this.config.projectAccess !== 'none') {
      const hostProject = resolve(this.config.hostProjectPath);
      const mode = this.config.projectAccess;
      createArgs.push(
        '--mount', `type=bind,source=${hostProject},target=${this.config.projectPath},${mode}`,
      );
    }

    createArgs.push(this.config.image);

    log.info(`Creating container "${name}" with image "${this.config.image}"`);
    const { stdout: createOutput } = await this.runDocker(createArgs);
    this.containerId = createOutput.trim();

    log.info(`Starting container "${name}" (${this.containerId.slice(0, 12)})`);
    await this.runDocker(['start', name]);

    return this.containerId;
  }

  /**
   * 在容器内执行命令
   *
   * 通过 `docker exec` 在运行中的容器内执行指定命令，
   * 支持超时控制和输出大小限制。
   */
  async exec(
    command: string,
    timeoutMs: number = this.config.defaultTimeoutMs,
  ): Promise<SandboxExecResult> {
    const name = this.config.containerName;

    const execArgs: string[] = [
      'exec',
      name,
      'sh', '-c', command,
    ];

    try {
      const { stdout, stderr } = await this.runDocker(execArgs, timeoutMs);
      return {
        exitCode: 0,
        stdout,
        stderr,
        timedOut: false,
      };
    } catch (error: unknown) {
      const dockerErr = error as DockerError;

      if (dockerErr.code === 137 || dockerErr.stderr?.includes('Killed')) {
        return {
          exitCode: 137,
          stdout: '',
          stderr: 'Process killed (likely OOM or timeout)',
          timedOut: true,
        };
      }

      const exitCode = dockerErr.code ?? 1;
      const stderrOutput = dockerErr.stderr || dockerErr.message || '';
      const stdoutOutput = (dockerErr as { stdout?: string }).stdout || '';

      return {
        exitCode: typeof exitCode === 'number' ? exitCode : 1,
        stdout: stdoutOutput,
        stderr: stderrOutput,
        timedOut: false,
      };
    }
  }

  /**
   * 通过 stdin 向容器内写入文件
   *
   * 使用 `docker exec -i` + `cat >` 方式写入，
   * 避免临时文件和额外的 docker cp 操作。
   */
  async writeFile(containerPath: string, content: string): Promise<void> {
    const name = this.config.containerName;

    const escapedPath = this.escapeShellArg(containerPath);
    const dirPath = escapedPath.replace(/\/[^/]+$/, '');

    const mkdirArgs: string[] = [
      'exec',
      name,
      'sh', '-c', `mkdir -p ${dirPath}`,
    ];

    try {
      await this.runDocker(mkdirArgs, 10000);
    } catch {
      // 目录可能已存在或父目录只读，忽略
    }

    const execArgs: string[] = [
      'exec', '-i',
      name,
      'sh', '-c', `cat > ${escapedPath}`,
    ];

    try {
      const { stdout, stderr } = await this.execDockerWithStdin(
        execArgs,
        content,
      );

      if (stderr) {
        log.warn(`writeFile stderr: ${stderr}`);
      }
    } catch (error: unknown) {
      throw new Error(
        `Failed to write file in sandbox: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * 停止并删除容器
   */
  async stopAndRemove(): Promise<void> {
    const name = this.config.containerName;

    try {
      log.info(`Stopping container "${name}"`);
      await this.runDocker(['stop', name], 10000);
    } catch (error: unknown) {
      log.warn(`Failed to stop container: ${getErrorMessage(error)}`);
    }

    try {
      await this.runDocker(['rm', '-f', name]);
      log.info(`Removed container "${name}"`);
    } catch (error: unknown) {
      log.warn(`Failed to remove container: ${getErrorMessage(error)}`);
    }

    this.containerId = null;
  }

  /**
   * 执行 docker 子命令
   *
   * @param args - docker 子命令参数
   * @param timeout - 超时时间（ms）
   */
  private async runDocker(
    args: string[],
    timeout: number = 60000,
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('docker', args, {
      timeout,
      maxBuffer: 5 * 1024 * 1024,
    });
  }

  /**
   * 通过 stdin 管道执行 docker 命令
   *
   * 用于 writeFile 场景，需要将内容通过 stdin 传入容器。
   */
  private async execDockerWithStdin(
    args: string[],
    stdinContent: string,
    timeoutMs: number = 30000,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGKILL');
          reject(new Error(`docker exec timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const error: DockerError = new Error(
            `docker exited with code ${code}: ${stderr}`,
          );
          error.code = code;
          error.stderr = stderr;
          reject(error);
        }
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      proc.stdin.write(stdinContent);
      proc.stdin.end();
    });
  }

  /**
   * 转义 shell 参数中的特殊字符
   *
   * 防止路径中包含空格或特殊字符导致命令注入。
   */
  private escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}
