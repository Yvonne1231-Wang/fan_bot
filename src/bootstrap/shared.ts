// ─── Bootstrap Shared Utilities ─────────────────────────────────────────────

import type { LLMClient } from '../llm/types.js';
import type { MessageHandler } from '../transport/adapter.js';
import type { SkillEntry } from '../skills/types.js';
import { createSubAgentTools } from '../agent/index.js';
import { getMemory, initMemory, LanceDBMemoryService } from '../memory/index.js';
import { registry, registerTool } from '../tools/registry.js';
import { calculatorTool } from '../tools/calculator.js';
import { readFileTool, writeFileTool, listDirTool } from '../tools/files.js';
import { shellTool } from '../tools/shell.js';
import { webSearchTool } from '../tools/web_search.js';
import { webFetchTool } from '../tools/web_fetch.js';
import { skillTool } from '../tools/skill.js';
import {
  memoryListTool,
  memoryDeleteTool,
  memorySearchTool,
} from '../tools/memory.js';
import { describeImageTool } from '../media-understanding/describe-image-tool.js';
import { CronStore, CronScheduler, CronExecutor } from '../cron/index.js';
import {
  cronCreateTool,
  cronListTool,
  cronDeleteTool,
  cronToggleTool,
  cronRunNowTool,
  setCronDeps,
} from '../tools/cron.js';
import {
  loadAllSkills,
  getSkillEntries,
  getGlobalLoader,
  loadSkillTools,
} from '../skills/index.js';
import type { MessageContext } from '../transport/unified.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('bootstrap');

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_SESSION_DIR = './sessions';
export const DEFAULT_HTTP_PORT = 3000;

// ─── Skills Cache ────────────────────────────────────────────────────────────

let cachedSkillEntries: SkillEntry[] = [];

/**
 * 获取当前缓存的技能列表
 */
export function getCachedSkillEntries(): SkillEntry[] {
  return cachedSkillEntries;
}

/**
 * 加载所有技能并启动文件监听
 */
export async function loadSkills(): Promise<void> {
  try {
    await loadAllSkills();
    cachedSkillEntries = getSkillEntries();
    log.info(`Loaded ${cachedSkillEntries.length} skills`);

    const loader = getGlobalLoader();
    loader.onChange((entries) => {
      cachedSkillEntries = entries;
      log.info(`Skills updated: ${entries.length} skills available`);
    });
    loader.startWatching();
  } catch (error) {
    log.warn(`Failed to load skills: ${error}`);
    cachedSkillEntries = [];
  }
}

/**
 * 停止技能文件监听器
 */
export async function stopSkillsWatcher(): Promise<void> {
  try {
    const loader = getGlobalLoader();
    loader.stopWatching();
  } catch (error) {
    log.warn(`Failed to stop skills watcher: ${error}`);
  }
}

// ─── Initialization Helpers ──────────────────────────────────────────────────

/**
 * 注册所有默认工具
 *
 * 主 Agent 只保留基础工具，复杂任务通过 sub-agent 处理
 */
export async function registerDefaultTools(
  llmClient: LLMClient,
): Promise<void> {
  registerTool(calculatorTool);
  registerTool(skillTool);
  registerTool(shellTool);
  registerTool(webSearchTool);
  registerTool(webFetchTool);
  registerTool(readFileTool);
  registerTool(writeFileTool);
  registerTool(listDirTool);
  registerTool(memoryListTool);
  registerTool(memoryDeleteTool);
  registerTool(memorySearchTool);
  registerTool(describeImageTool);

  const skillTools = await loadSkillTools();
  for (const tool of skillTools) {
    registerTool(tool);
  }

  const subAgentCtx = {
    llmClient,
    baseRegistry: registry,
  };

  const subAgentTools = createSubAgentTools(subAgentCtx);
  for (const tool of subAgentTools) {
    registerTool(tool);
    log.info(`Registered sub-agent tool: ${tool.schema.name}`);
  }
}

/**
 * 初始化记忆服务。
 * 使用 initMemory() 通过工厂创建，支持可插拔后端。
 * 向后兼容：默认使用 LanceDB。
 */
export async function initMemoryWithLLM(llmClient: LLMClient): Promise<void> {
  const memory = await initMemory(undefined, llmClient);
  // 向后兼容：如果是 LanceDB 实例，确保 LLM client 已设置
  if (memory instanceof LanceDBMemoryService) {
    memory.setLLMClient(llmClient);
  }
}

/**
 * 初始化并启动 Cron 调度器
 */
export function initCronScheduler(options: {
  llmClient: LLMClient;
  messageHandler: MessageHandler;
  resultSender?: (result: string, context: MessageContext) => Promise<void>;
}): CronScheduler {
  const { llmClient, messageHandler, resultSender } = options;

  const store = new CronStore();
  const executor = new CronExecutor({
    llmClient,
    toolRegistry: registry,
    memory: getMemory(),
    notificationHandler: messageHandler,
    resultSender,
  });
  const scheduler = new CronScheduler(store, executor);

  setCronDeps(store, scheduler);

  registerTool(cronCreateTool);
  registerTool(cronListTool);
  registerTool(cronDeleteTool);
  registerTool(cronToggleTool);
  registerTool(cronRunNowTool);

  return scheduler;
}
