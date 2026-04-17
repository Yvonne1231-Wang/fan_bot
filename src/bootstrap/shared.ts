// ─── Bootstrap Shared Utilities ─────────────────────────────────────────────

import type { LLMClient } from '../llm/types.js';
import type { MessageHandler } from '../transport/adapter.js';
import type { SkillEntry } from '../skills/types.js';
import type { Tool, ToolRegistry } from '../tools/types.js';
import { createSubAgentTools } from '../agent/index.js';
import {
  getMemory,
  initMemory,
  LanceDBMemoryService,
} from '../memory/index.js';
import { SessionArchive } from '../session/archive.js';
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

// ─── Session Archive ─────────────────────────────────────────────────────────

let globalArchive: SessionArchive | null = null;

/**
 * 获取或创建全局 SessionArchive 实例。
 */
function getSessionArchive(): SessionArchive {
  if (!globalArchive) {
    globalArchive = new SessionArchive('.fan_bot/archive.db');
  }
  return globalArchive;
}
// ─── Initialization Helpers ──────────────────────────────────────────────────

/**
 * 为 sub-agent 构建增强版工具注册表，
 * 在全局 registry 基础上注入主 Agent 不应直接访问的工具。
 */
function augmentRegistry(base: ToolRegistry, extraTools: Tool[]): ToolRegistry {
  const extraMap = new Map(extraTools.map((t) => [t.schema.name, t]));

  return {
    register: (tool: Tool) => base.register(tool),
    getSchemas: () => [
      ...base.getSchemas(),
      ...extraTools.map((t) => t.schema),
    ],
    dispatch: (name, input) => {
      const extra = extraMap.get(name);
      if (extra) return extra.handler(input);
      return base.dispatch(name, input);
    },
    dispatchWithConfirmation: (name, input, confirmFn) => {
      const extra = extraMap.get(name);
      if (extra) {
        if (extra.requiresConfirmation && confirmFn) {
          const preview = `${name}(${JSON.stringify(input)})`;
          return confirmFn(preview).then((approved) =>
            approved
              ? extra.handler(input)
              : 'Tool execution cancelled by user.',
          );
        }
        return extra.handler(input);
      }
      return base.dispatchWithConfirmation(name, input, confirmFn);
    },
    isParallelSafe: (name) => {
      const extra = extraMap.get(name);
      if (extra) return extra.parallelSafe === true;
      return base.isParallelSafe(name);
    },
  };
}

/**
 * 注册所有默认工具
 *
 * 主 Agent 只保留基础工具，图片分析通过 vision sub-agent 处理，
 * describe_image 仅注入到 sub-agent 的工具注册表中。
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

  const skillTools = await loadSkillTools();
  for (const tool of skillTools) {
    registerTool(tool);
  }

  const subAgentCtx = {
    llmClient,
    baseRegistry: augmentRegistry(registry, [describeImageTool]),
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
    // 注入 SessionArchive 以启用 FTS5 归档搜索
    memory.setSessionArchive(getSessionArchive());
  }
}

/**
 * 初始化并启动 Cron 调度器
 */
export function initCronScheduler(options: {
  llmClient: LLMClient;
  messageHandler: MessageHandler;
  resultSender?: (result: string, context: MessageContext) => Promise<void>;
  defaultNotifyChatId?: string;
}): CronScheduler {
  const { llmClient, messageHandler, resultSender, defaultNotifyChatId } =
    options;

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

  ensureSkillNotifyTask(store, defaultNotifyChatId);

  return scheduler;
}

const SKILL_NOTIFY_TASK_NAME = 'skill-pending-notify';

/**
 * 确保 skill-notify 定时任务存在
 *
 * 每天早上 9 点扫描 pending skills 并推送飞书通知。
 * 如果已有同名任务则跳过，避免重复创建。
 */
async function ensureSkillNotifyTask(
  store: CronStore,
  chatId?: string,
): Promise<void> {
  try {
    await store.initialize();

    const existing = await store.list();
    const found = existing.some(
      (t) => t.name === SKILL_NOTIFY_TASK_NAME && t.type === 'skill-notify',
    );

    if (found) {
      log.debug('skill-notify cron task already exists, skipping');
      return;
    }

    const notificationTarget = chatId
      ? { chatId, receiveIdType: 'chat_id' as const }
      : undefined;

    await store.create({
      name: SKILL_NOTIFY_TASK_NAME,
      type: 'skill-notify',
      cronExpression: '0 9 * * *',
      payload: {
        chatId,
        receiveIdType: 'chat_id' as const,
      },
      enabled: true,
      notificationTarget,
    });

    log.info('Auto-created skill-notify cron task (daily 9:00 AM)');
  } catch (error) {
    log.warn(`Failed to ensure skill-notify task: ${error}`);
  }
}
