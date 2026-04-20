// ─── Sandbox Module Entry ───────────────────────────────────────────────────

export { SandboxServiceImpl } from './service.js';
export { SandboxSecurityError, buildConfigFromEnv } from './service.js';
export { DockerManager } from './docker.js';
export type {
  SandboxConfig,
  SandboxExecResult,
  SandboxService,
  SandboxMode,
  SandboxNetwork,
  ProjectAccess,
  SandboxScope,
  SandboxSessionContext,
} from './types.js';
export { DEFAULT_SANDBOX_CONFIG } from './types.js';

import { SandboxServiceImpl } from './service.js';
import { buildConfigFromEnv } from './service.js';
import type { SandboxConfig, SandboxService, SandboxSessionContext } from './types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('sandbox');

/** 全局沙箱服务实例 */
let globalSandbox: SandboxServiceImpl | null = null;

/**
 * 创建沙箱服务实例
 *
 * 从环境变量和可选的覆盖配置构建 SandboxConfig，
 * 创建 SandboxServiceImpl 实例并设为全局实例。
 *
 * @param overrides - 可选的配置覆盖项
 * @returns 沙箱服务实例
 */
export function createSandboxService(
  overrides: Partial<SandboxConfig> = {},
): SandboxServiceImpl {
  const config = buildConfigFromEnv(overrides);
  globalSandbox = new SandboxServiceImpl(config);
  log.info(`Sandbox service created (enabled: ${config.enabled})`);
  return globalSandbox;
}

/**
 * 获取全局沙箱服务实例
 *
 * 如果尚未创建，则使用默认配置自动创建一个。
 *
 * @returns 沙箱服务实例
 */
export function getSandboxService(): SandboxService {
  if (!globalSandbox) {
    globalSandbox = new SandboxServiceImpl(buildConfigFromEnv());
  }
  return globalSandbox;
}

/**
 * 初始化沙箱
 *
 * 创建服务实例并初始化容器。
 * 如果沙箱未启用，则静默跳过。
 */
export async function initSandbox(
  overrides: Partial<SandboxConfig> = {},
): Promise<void> {
  const sandbox = createSandboxService(overrides);
  await sandbox.init();
}

/**
 * 销毁沙箱
 *
 * 停止并删除容器，清理资源。
 */
export async function destroySandbox(): Promise<void> {
  if (globalSandbox) {
    await globalSandbox.destroy();
    globalSandbox = null;
  }
}

/**
 * 设置沙箱的当前会话上下文
 *
 * Shared scope 下，通过 sessionId 将文件操作路由到
 * /workspace/sessions/{sessionId}/ 下，实现文件级会话隔离。
 * 应在每次工具调用前调用，传入当前请求的 sessionId。
 */
export function setSandboxSessionContext(ctx: SandboxSessionContext): void {
  const sandbox = getSandboxService();
  sandbox.setSessionContext(ctx);
}
