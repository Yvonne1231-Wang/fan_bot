// ─── Sandbox Service Implementation ─────────────────────────────────────────

import { posix, isAbsolute, resolve } from 'path';
import { mkdir } from 'fs/promises';
import type { SandboxConfig, SandboxExecResult, SandboxService, SandboxSessionContext } from './types.js';
import { DEFAULT_SANDBOX_CONFIG } from './types.js';
import { DockerManager } from './docker.js';
import { createDebug } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';

const log = createDebug('sandbox:service');

/** 容器内禁止访问的路径前缀 */
const BLOCKED_PATH_PREFIXES = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/root',
  '/home',
];

/** 危险 shell 命令正则 */
const BLOCKED_COMMAND_PATTERNS = [
  /docker\s+(run|exec|build|push|rm)/i,
  /curl\s+.*\|\s*sh/i,
  /wget\s+.*\|\s*sh/i,
  /mkfs/i,
  /dd\s+if=/i,
];

/** 沙箱输出最大字符数 */
const MAX_OUTPUT_CHARS = 20000;

/**
 * 沙箱安全错误
 *
 * 当路径逃逸或命令被阻止时抛出。
 */
export class SandboxSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxSecurityError';
  }
}

/**
 * 从环境变量构建沙箱配置
 *
 * 所有配置项均可通过 SANDBOX_* 环境变量覆盖默认值。
 */
export function buildConfigFromEnv(
  overrides: Partial<SandboxConfig> = {},
): SandboxConfig {
  return {
    ...DEFAULT_SANDBOX_CONFIG,
    enabled: process.env.SANDBOX_ENABLED === 'true' || overrides.enabled === true,
    mode: (process.env.SANDBOX_MODE as SandboxConfig['mode']) || overrides.mode || DEFAULT_SANDBOX_CONFIG.mode,
    scope: (process.env.SANDBOX_SCOPE as SandboxConfig['scope']) || overrides.scope || DEFAULT_SANDBOX_CONFIG.scope,
    image: process.env.SANDBOX_IMAGE || overrides.image || DEFAULT_SANDBOX_CONFIG.image,
    containerName: process.env.SANDBOX_CONTAINER_NAME || overrides.containerName || DEFAULT_SANDBOX_CONFIG.containerName,
    workspacePath: process.env.SANDBOX_WORKSPACE_PATH || overrides.workspacePath || DEFAULT_SANDBOX_CONFIG.workspacePath,
    network: (process.env.SANDBOX_NETWORK as SandboxConfig['network']) || overrides.network || DEFAULT_SANDBOX_CONFIG.network,
    memoryMB: Number(process.env.SANDBOX_MEMORY_MB) || overrides.memoryMB || DEFAULT_SANDBOX_CONFIG.memoryMB,
    cpuQuota: Number(process.env.SANDBOX_CPU_QUOTA) || overrides.cpuQuota || DEFAULT_SANDBOX_CONFIG.cpuQuota,
    defaultTimeoutMs: Number(process.env.SANDBOX_TIMEOUT_MS) || overrides.defaultTimeoutMs || DEFAULT_SANDBOX_CONFIG.defaultTimeoutMs,
    idleTimeoutSec: Number(process.env.SANDBOX_IDLE_TIMEOUT_SEC) || overrides.idleTimeoutSec || DEFAULT_SANDBOX_CONFIG.idleTimeoutSec,
    hostWorkspacePath: process.env.SANDBOX_WORKSPACE || overrides.hostWorkspacePath || DEFAULT_SANDBOX_CONFIG.hostWorkspacePath,
    hostProjectPath: process.env.SANDBOX_PROJECT_PATH || overrides.hostProjectPath || DEFAULT_SANDBOX_CONFIG.hostProjectPath,
    projectPath: process.env.SANDBOX_PROJECT_MOUNT || overrides.projectPath || DEFAULT_SANDBOX_CONFIG.projectPath,
    projectAccess: (process.env.SANDBOX_PROJECT_ACCESS as SandboxConfig['projectAccess']) || overrides.projectAccess || DEFAULT_SANDBOX_CONFIG.projectAccess,
  };
}

/**
 * SandboxService 实现
 *
 * Shared Scope 模式：全局共享一个 Docker 容器，
 * 所有会话的工具执行都在同一个容器内完成。
 */
export class SandboxServiceImpl implements SandboxService {
  private config: SandboxConfig;
  private readonly docker: DockerManager;
  private initialized = false;
  private recoveryAttempts = 0;
  private static readonly MAX_RECOVERY_ATTEMPTS = 2;
  private sessionContext: SandboxSessionContext = {};

  constructor(config: SandboxConfig) {
    this.config = config;
    this.docker = new DockerManager(config);
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): SandboxConfig {
    return { ...this.config };
  }

  /**
   * 设置当前会话上下文
   *
   * Shared scope 下，所有会话共享一个容器，
   * 但通过 sessionId 将文件操作路由到 /workspace/sessions/{sessionId}/ 下，
   * 实现文件级会话隔离。
   */
  setSessionContext(ctx: SandboxSessionContext): void {
    this.sessionContext = ctx;
    if (ctx.sessionId) {
      log.debug(`Session context set: ${ctx.sessionId}`);
    }
  }

  /**
   * 获取当前会话的工作区路径
   *
   * Shared scope: /workspace/sessions/{sessionId}/
   * 无 sessionId 时: /workspace/
   */
  getSessionWorkspace(): string {
    const { workspacePath } = this.config;
    const { sessionId } = this.sessionContext;
    if (sessionId) {
      return posix.join(workspacePath, 'sessions', sessionId);
    }
    return workspacePath;
  }

  async init(): Promise<void> {
    if (!this.config.enabled) {
      log.info('Sandbox disabled, skipping initialization');
      return;
    }

    try {
      const dockerAvailable = await this.docker.isDockerAvailable();
      if (!dockerAvailable) {
        log.error('Docker daemon not available, disabling sandbox');
        this.config.enabled = false;
        return;
      }

      const imageExists = await this.docker.imageExists(this.config.image);
      if (!imageExists) {
        log.error(
          `Sandbox image "${this.config.image}" not found. ` +
          `Run ./scripts/sandbox-setup.sh to build it.`,
        );
        this.config.enabled = false;
        return;
      }

      await this.ensureHostWorkspace();

      await this.docker.createAndStart();
      this.initialized = true;

      log.info(
        `Sandbox initialized: container="${this.config.containerName}", ` +
        `image="${this.config.image}", network="${this.config.network}"`,
      );
    } catch (error: unknown) {
      log.error(`Failed to initialize sandbox: ${getErrorMessage(error)}`);
      this.config.enabled = false;
    }
  }

  async execute(
    command: string,
    timeoutMs?: number,
  ): Promise<SandboxExecResult> {
    this.ensureReady();

    this.validateCommand(command);

    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;

    try {
      const result = await this.docker.exec(command, timeout);
      result.stdout = this.truncateOutput(result.stdout);
      result.stderr = this.truncateOutput(result.stderr);
      this.recoveryAttempts = 0;
      return result;
    } catch (error: unknown) {
      if (error instanceof SandboxSecurityError) {
        throw error;
      }

      if (this.recoveryAttempts >= SandboxServiceImpl.MAX_RECOVERY_ATTEMPTS) {
        log.error(
          `Max recovery attempts (${SandboxServiceImpl.MAX_RECOVERY_ATTEMPTS}) reached, giving up`,
        );
        this.config.enabled = false;
        throw new Error(
          `Sandbox recovery limit reached, sandbox disabled: ${getErrorMessage(error)}`,
        );
      }

      this.recoveryAttempts++;
      log.warn(
        `Sandbox execute failed (recovery attempt ${this.recoveryAttempts}/${SandboxServiceImpl.MAX_RECOVERY_ATTEMPTS}): ${getErrorMessage(error)}`,
      );
      await this.recover();
      return this.docker.exec(command, timeout);
    }
  }

  async readFile(path: string): Promise<string> {
    this.ensureReady();

    const resolvedPath = this.resolvePath(path);

    const result = await this.execute(`cat ${this.escapeShellArg(resolvedPath)}`);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file "${path}": ${result.stderr}`);
    }

    return result.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.ensureReady();

    const resolvedPath = this.resolvePath(path);

    if (this.isProjectPath(resolvedPath) && this.config.projectAccess === 'ro') {
      throw new SandboxSecurityError(
        `Cannot write to project path (read-only): ${path}`,
      );
    }

    try {
      await this.docker.writeFile(resolvedPath, content);
    } catch (error: unknown) {
      log.warn(`Sandbox writeFile failed, attempting recovery: ${getErrorMessage(error)}`);
      await this.recover();
      await this.docker.writeFile(resolvedPath, content);
    }
  }

  async listDir(path: string): Promise<string[]> {
    this.ensureReady();

    const resolvedPath = this.resolvePath(path);

    const result = await this.execute(`ls -1F ${this.escapeShellArg(resolvedPath)}`);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list directory "${path}": ${result.stderr}`);
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async destroy(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    try {
      await this.docker.stopAndRemove();
      this.initialized = false;
      log.info('Sandbox destroyed');
    } catch (error: unknown) {
      log.error(`Failed to destroy sandbox: ${getErrorMessage(error)}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.config.enabled || !this.initialized) {
      return false;
    }

    try {
      const running = await this.docker.isContainerRunning(
        this.config.containerName,
      );
      if (!running) {
        return false;
      }

      const result = await this.docker.exec('echo ok', 5000);
      return result.exitCode === 0 && result.stdout.trim() === 'ok';
    } catch {
      return false;
    }
  }

  resolvePath(inputPath: string): string {
    const workspace = this.config.workspacePath;
    const project = this.config.projectPath;
    const sessionWorkspace = this.getSessionWorkspace();

    const resolved = isAbsolute(inputPath)
      ? posix.normalize(inputPath)
      : posix.normalize(posix.join(sessionWorkspace, inputPath));

    const isUnderWorkspace = resolved.startsWith(workspace);
    const isUnderProject = this.config.projectAccess !== 'none' && resolved.startsWith(project);

    if (!isUnderWorkspace && !isUnderProject) {
      throw new SandboxSecurityError(
        `Path escapes sandbox workspace: ${inputPath}`,
      );
    }

    for (const prefix of BLOCKED_PATH_PREFIXES) {
      if (resolved.startsWith(prefix)) {
        throw new SandboxSecurityError(
          `Path not allowed in sandbox: ${inputPath}`,
        );
      }
    }

    return resolved;
  }

  /**
   * 检查路径是否在项目目录下（只读区域）
   */
  isProjectPath(resolvedPath: string): boolean {
    if (this.config.projectAccess === 'none') {
      return false;
    }
    return resolvedPath.startsWith(this.config.projectPath);
  }

  /**
   * 确保宿主机工作区目录存在
   */
  private async ensureHostWorkspace(): Promise<void> {
    const hostPath = resolve(this.config.hostWorkspacePath);
    try {
      await mkdir(hostPath, { recursive: true });
      await mkdir(`${hostPath}/sessions`, { recursive: true });
      await mkdir(`${hostPath}/data`, { recursive: true });
      await mkdir(`${hostPath}/tmp`, { recursive: true });
    } catch (error: unknown) {
      log.warn(`Failed to create host workspace: ${getErrorMessage(error)}`);
    }
  }

  /**
   * 确保沙箱已就绪，否则抛出错误
   */
  private ensureReady(): void {
    if (!this.config.enabled) {
      throw new Error('Sandbox is not enabled');
    }
    if (!this.initialized) {
      throw new Error('Sandbox is not initialized. Call init() first.');
    }
  }

  /**
   * 验证命令是否安全
   *
   * 纵深防御：即使容器已隔离，仍阻止已知的危险命令模式。
   */
  private validateCommand(command: string): void {
    for (const pattern of BLOCKED_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        throw new SandboxSecurityError(
          `Command blocked by sandbox policy: ${command.slice(0, 80)}`,
        );
      }
    }
  }

  /**
   * 截断过长输出
   */
  private truncateOutput(output: string): string {
    if (output.length > MAX_OUTPUT_CHARS) {
      log.warn(
        `Sandbox output truncated: ${output.length} -> ${MAX_OUTPUT_CHARS} chars`,
      );
      return (
        output.slice(0, MAX_OUTPUT_CHARS) +
        '\n\n[... output truncated due to size limit ...]'
      );
    }
    return output;
  }

  /**
   * 转义 shell 参数
   */
  private escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }

  /**
   * 尝试恢复沙箱容器
   *
   * 当容器异常停止或被删除时，重新创建并启动。
   */
  private async recover(): Promise<void> {
    log.info('Attempting sandbox recovery...');

    try {
      const running = await this.docker.isContainerRunning(
        this.config.containerName,
      );

      if (!running) {
        log.info('Container not running, recreating...');
        await this.docker.createAndStart();
      }

      this.initialized = true;
      log.info('Sandbox recovery successful');
    } catch (error: unknown) {
      this.initialized = false;
      this.config.enabled = false;
      log.error(`Sandbox recovery failed: ${getErrorMessage(error)}`);
      throw new Error(
        `Sandbox recovery failed, sandbox disabled: ${getErrorMessage(error)}`,
      );
    }
  }
}
