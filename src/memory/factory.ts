// ─── Memory Provider Factory ────────────────────────────────────────────────
//
// 可插拔的记忆后端工厂。通过配置选择不同的存储实现，
// 无需修改业务代码。

import type { MemoryService } from './types.js';
import type { LLMClient } from '../llm/types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('memory:factory');

export type MemoryBackend = 'lancedb' | 'json';

export interface MemoryConfig {
  backend: MemoryBackend;
  /** LanceDB 配置 */
  lancedb?: {
    dbPath?: string;
  };
  /** JSON 配置（轻量级，适合测试） */
  json?: {
    dir?: string;
  };
}

/** 默认配置 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  backend: 'lancedb',
  lancedb: {
    dbPath: '.memory/lancedb',
  },
};

/**
 * 根据配置创建对应的 MemoryService 实例。
 * 使用动态 import 避免加载不必要的依赖。
 */
export async function createMemoryService(
  config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
  llmClient?: LLMClient,
): Promise<MemoryService> {
  log.info(`Creating memory service with backend: ${config.backend}`);

  switch (config.backend) {
    case 'lancedb': {
      const { LanceDBMemoryService } = await import('./lancedb-memory.js');
      const dbPath = config.lancedb?.dbPath ?? '.memory/lancedb';
      const service = new LanceDBMemoryService(dbPath, llmClient);
      log.info(`LanceDB memory initialized at ${dbPath}`);
      return service;
    }
    case 'json': {
      const { JsonMemoryService } = await import('./json-memory.js');
      const dir = config.json?.dir ?? '.memory';
      const service = new JsonMemoryService(dir);
      log.info(`JSON memory initialized at ${dir}`);
      return service;
    }
    default: {
      const exhaustive: never = config.backend;
      throw new Error(`Unknown memory backend: ${exhaustive}`);
    }
  }
}
