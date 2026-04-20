// ─── Sandbox Type Definitions ──────────────────────────────────────────────

/** 沙箱运行模式 */
export type SandboxMode = 'off' | 'all';

/** 容器网络模式 */
export type SandboxNetwork = 'none' | 'bridge';

/** 项目目录访问模式 */
export type ProjectAccess = 'none' | 'ro' | 'rw';

/** 沙箱隔离范围 */
export type SandboxScope = 'shared';

/** 沙箱会话上下文 */
export interface SandboxSessionContext {
  /** 当前会话 ID */
  sessionId?: string;
}

/** 沙箱配置 */
export interface SandboxConfig {
  /** 是否启用沙箱 */
  enabled: boolean;

  /** 运行模式：off=关闭, all=所有工具走沙箱 */
  mode: SandboxMode;

  /** 隔离范围：shared=所有会话共享一个容器 */
  scope: SandboxScope;

  /** Docker 镜像名称 */
  image: string;

  /** 容器名称 */
  containerName: string;

  /** 工作区在容器内的挂载路径（可读写） */
  workspacePath: string;

  /** 网络模式 */
  network: SandboxNetwork;

  /** 内存限制（MB） */
  memoryMB: number;

  /** CPU 配额（微秒/周期，100000=1核） */
  cpuQuota: number;

  /** 默认命令执行超时（ms） */
  defaultTimeoutMs: number;

  /** 容器空闲超时自动销毁（秒），0=不自动销毁 */
  idleTimeoutSec: number;

  /** 宿主机工作区路径（挂载到容器的 workspacePath，可读写） */
  hostWorkspacePath: string;

  /** 宿主机项目目录路径（挂载到容器的 projectPath） */
  hostProjectPath: string;

  /** 项目目录在容器内的挂载路径 */
  projectPath: string;

  /** 项目目录访问模式：none=不挂载, ro=只读, rw=读写 */
  projectAccess: ProjectAccess;
}

/** 沙箱执行结果 */
export interface SandboxExecResult {
  /** 进程退出码 */
  exitCode: number;

  /** 标准输出 */
  stdout: string;

  /** 标准错误 */
  stderr: string;

  /** 是否超时 */
  timedOut: boolean;
}

/** 沙箱服务接口 */
export interface SandboxService {
  /** 是否启用 */
  isEnabled(): boolean;

  /** 获取当前配置 */
  getConfig(): SandboxConfig;

  /** 初始化沙箱（创建并启动容器） */
  init(): Promise<void>;

  /** 在沙箱内执行命令 */
  execute(command: string, timeoutMs?: number): Promise<SandboxExecResult>;

  /** 在沙箱内读取文件 */
  readFile(path: string): Promise<string>;

  /** 在沙箱内写入文件 */
  writeFile(path: string, content: string): Promise<void>;

  /** 在沙箱内列出目录 */
  listDir(path: string): Promise<string[]>;

  /** 销毁沙箱（停止并删除容器） */
  destroy(): Promise<void>;

  /** 检查沙箱健康状态 */
  healthCheck(): Promise<boolean>;

  /** 将用户路径解析为沙箱内安全路径 */
  resolvePath(inputPath: string): string;

  /** 检查路径是否在项目目录下（只读区域） */
  isProjectPath(resolvedPath: string): boolean;

  /** 设置当前会话上下文 */
  setSessionContext(ctx: SandboxSessionContext): void;

  /** 获取当前会话的工作区路径 */
  getSessionWorkspace(): string;
}

/** 默认沙箱配置 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  mode: 'all',
  scope: 'shared',
  image: 'fan-bot-sandbox:latest',
  containerName: 'fan-bot-sandbox',
  workspacePath: '/workspace',
  network: 'none',
  memoryMB: 512,
  cpuQuota: 100000,
  defaultTimeoutMs: 30000,
  idleTimeoutSec: 0,
  hostWorkspacePath: './sandbox-workspace',
  hostProjectPath: '.',
  projectPath: '/project',
  projectAccess: 'ro',
};
