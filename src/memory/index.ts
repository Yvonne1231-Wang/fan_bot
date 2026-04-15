// ─── Memory Module Entry ────────────────────────────────────────────────────

export {
  type MemoryService,
  type MemoryRecord,
  type Scope,
  type SearchResult,
} from './types.js';
export { JsonMemoryService } from './json-memory.js';
export { LanceDBMemoryService } from './lancedb-memory.js';
export {
  createMemoryService,
  type MemoryConfig,
  type MemoryBackend,
  DEFAULT_MEMORY_CONFIG,
} from './factory.js';

import { LanceDBMemoryService } from './lancedb-memory.js';
import type { MemoryService } from './types.js';
import type { MemoryConfig } from './factory.js';
import type { LLMClient } from '../llm/types.js';
import { createMemoryService, DEFAULT_MEMORY_CONFIG } from './factory.js';

let globalMemory: MemoryService | null = null;

/**
 * 初始化全局记忆服务。应在应用启动时调用一次。
 * 如果已初始化，返回现有实例。
 */
export async function initMemory(
  config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
  llmClient?: LLMClient,
): Promise<MemoryService> {
  if (globalMemory) {
    return globalMemory;
  }
  globalMemory = await createMemoryService(config, llmClient);
  return globalMemory;
}

/**
 * 获取全局记忆服务实例。
 *
 * 向后兼容：如果未调用 initMemory()，自动使用默认 LanceDB 配置。
 * 新代码应优先使用 initMemory() 显式初始化。
 */
export function getMemory(): MemoryService {
  if (!globalMemory) {
    // 向后兼容：同步创建 LanceDB（静态 import 已在顶部）
    globalMemory = new LanceDBMemoryService();
  }
  return globalMemory;
}

/**
 * 重置全局记忆服务（主要用于测试）。
 */
export function resetMemory(): void {
  globalMemory = null;
}
