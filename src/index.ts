// ─── Agent Entry Point ──────────────────────────────────────────────────────

import { config } from 'dotenv';
import type { LLMClient, AgentCallbacks } from './llm/types.js';

config();

import { createInterface } from 'readline';
import { createLLMClientFromEnv } from './llm/index.js';
import {
  runAgent,
  buildSystemPrompt,
  createPlan,
  shouldPlan,
  extractMemories,
  createSubAgentTools,
} from './agent/index.js';
import { createSessionManager, JSONLStore } from './session/index.js';
import { getMemory, LanceDBMemoryService } from './memory/index.js';
import { getUserId } from './user.js';
import { registry, registerTool } from './tools/registry.js';
import { calculatorTool } from './tools/calculator.js';
import { readFileTool, writeFileTool, listDirTool } from './tools/files.js';
import { shellTool } from './tools/shell.js';
import { webSearchTool } from './tools/web_search.js';
import { webFetchTool } from './tools/web_fetch.js';
import { skillTool } from './tools/skill.js';
import {
  CLIChannelAdapter,
  HTTPChannelAdapter,
  parseArgs,
  printHelp,
  type UnifiedMessage,
  type UnifiedResponse,
  type MessageHandler,
} from './transport/index.js';
import { createPermissionServiceFromEnv } from './permission/index.js';
import {
  FeishuChannelAdapter,
  type FeishuAdapterConfig,
} from './feishu/index.js';
import { createDebug } from './utils/debug.js';
import {
  loadAllSkills,
  getSkillEntries,
  getGlobalLoader,
} from './skills/index.js';
import {
  runMediaUnderstanding,
  loadMediaConfigFromEnv,
  unifiedToMsgContext,
} from './media-understanding/index.js';
import type {
  MediaConfig,
  MediaUnderstandingResult,
} from './media-understanding/types.js';
import type { SkillEntry } from './skills/types.js';
import {
  CronStore,
  CronScheduler,
  CronExecutor,
  type CronResultSender,
} from './cron/index.js';
import {
  cronCreateTool,
  cronListTool,
  cronDeleteTool,
  cronToggleTool,
  cronRunNowTool,
  setCronDeps,
} from './tools/cron.js';

const log = createDebug('main');

// ─── Skills Cache ────────────────────────────────────────────────────────────

let cachedSkillEntries: SkillEntry[] = [];

async function loadSkills(): Promise<void> {
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

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SESSION_DIR = './sessions';
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_MAX_AGENT_ITERATIONS = 10;

/**
 * 注册所有默认工具
 * 主 Agent 只保留基础工具，复杂任务通过 sub-agent 处理
 */
function registerDefaultTools(llmClient: LLMClient): void {
  registerTool(calculatorTool);
  registerTool(skillTool);
  registerTool(shellTool);
  registerTool(webSearchTool);
  registerTool(webFetchTool);
  registerTool(readFileTool);
  registerTool(writeFileTool);
  registerTool(listDirTool);

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
 * 初始化记忆服务的 LLM 客户端
 */
function initMemoryWithLLM(llmClient: LLMClient): void {
  const memory = getMemory();
  if (memory instanceof LanceDBMemoryService) {
    memory.setLLMClient(llmClient);
  }
}

/**
 * 初始化并启动 Cron 调度器
 */
function initCronScheduler(options: {
  llmClient: LLMClient;
  messageHandler: MessageHandler;
  resultSender?: (
    result: string,
    context: import('./transport/unified.js').MessageContext,
  ) => Promise<void>;
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

/**
 * 创建消息处理器
 *
 * @param options - 处理器配置选项
 * @returns 消息处理器函数
 */
function createMessageHandler(options: {
  llmClient: LLMClient;
  sessionManager: ReturnType<typeof createSessionManager>;
  confirmFn?: (preview: string) => Promise<boolean>;
  onText?: (delta: string) => void;
  mediaConfig?: MediaConfig;
  getAbortSignal?: (chatId?: string) => AbortSignal | undefined;
}): MessageHandler {
  const {
    llmClient,
    sessionManager,
    confirmFn,
    onText,
    mediaConfig,
    getAbortSignal,
  } = options;
  const memory = getMemory();

  return async (
    message: UnifiedMessage,
    callbacks?: AgentCallbacks,
  ): Promise<UnifiedResponse> => {
    const sessionId = message.context.sessionId;
    const userId = message.context.userId;

    if (userId && memory instanceof LanceDBMemoryService) {
      memory.setUserId(userId);
    }

    const userQuery = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');

    const [messages, mediaResult] = await Promise.all([
      sessionManager.load(sessionId),
      runMediaUnderstanding(unifiedToMsgContext(message), mediaConfig!),
    ]);

    const systemPrompt = await buildSystemPrompt({
      agentName: 'fan_bot',
      memory,
      userQuery,
      skills: cachedSkillEntries,
    });

    let responseText = '';
    let effectivePrompt = userQuery;

    if (mediaResult?.outputs?.length) {
      const mediaDescriptions: string[] = [];
      for (const output of mediaResult.outputs) {
        if (output.capability === 'image') {
          const pathInfo = output.attachmentPath
            ? `\n[Image file path: ${output.attachmentPath}]`
            : '';
          mediaDescriptions.push(
            `[Image Description]: ${output.text}${pathInfo}`,
          );
        } else if (output.capability === 'audio') {
          mediaDescriptions.push(`[Audio Transcription]: ${output.text}`);
        } else if (output.capability === 'video') {
          mediaDescriptions.push(`[Video Summary]: ${output.text}`);
        }
      }
      if (mediaDescriptions.length > 0) {
        effectivePrompt = `${userQuery}\n\n${mediaDescriptions.join('\n')}`;
      }
    }

    if (shouldPlan(userQuery)) {
      const plan = await createPlan(effectivePrompt, llmClient);
      let lastResult = '';

      for (const step of plan.steps) {
        step.status = 'running';
        const result = await runAgent({
          prompt: `${step.title}\n\nContext from previous steps:\n${lastResult}`,
          llmClient,
          toolRegistry: registry,
          initialMessages: messages,
          maxIterations:
            Number(process.env.MAX_AGENT_ITERATIONS) ||
            DEFAULT_MAX_AGENT_ITERATIONS,
          systemPrompt,
          confirmFn,
          callbacks,
          abortSignal: getAbortSignal?.(
            message.context.metadata.chatId as string,
          ),
        });
        step.status = 'done';
        step.result = result.response;
        lastResult = result.response;
        await sessionManager.save(sessionId, result.messages);
      }

      responseText = `Plan complete.\n\nFinal result:\n${lastResult}`;

      setImmediate(async () => {
        try {
          if (memory) {
            const extraction = await extractMemories(
              messages.slice(-8),
              llmClient,
              memory,
            );
            if (extraction.extracted.length > 0) {
              log.info(
                `Background: Auto-extracted ${extraction.extracted.length} memories from plan`,
              );
            }
          }
        } catch (error) {
          log.error(`Background processing failed: ${error}`);
        }
      });
    } else {
      const result = await runAgent({
        prompt: effectivePrompt,
        llmClient,
        toolRegistry: registry,
        initialMessages: messages,
        maxIterations:
          Number(process.env.MAX_AGENT_ITERATIONS) ||
          DEFAULT_MAX_AGENT_ITERATIONS,
        systemPrompt,
        onText,
        confirmFn,
        callbacks,
        abortSignal: getAbortSignal?.(
          message.context.metadata.chatId as string,
        ),
      });

      responseText = result.response;
      await sessionManager.save(sessionId, result.messages);

      setImmediate(async () => {
        try {
          const compressed = await sessionManager.compress(result.messages);
          await sessionManager.save(sessionId, compressed);

          if (result.messages.length >= 2) {
            const lastMessages = result.messages.slice(-8);
            const extraction = await extractMemories(
              lastMessages,
              llmClient,
              memory,
            );
            if (extraction.extracted.length > 0) {
              log.info(
                `Background: Auto-extracted ${extraction.extracted.length} memories`,
              );
            }
          }
        } catch (error) {
          log.error(`Background processing failed: ${error}`);
        }
      });
    }

    return {
      id: `resp-${Date.now()}`,
      messageId: message.id,
      content: [{ type: 'text', text: responseText }],
      timestamp: Date.now(),
      done: true,
    };
  };
}

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * 主入口函数
 */
async function main(): Promise<void> {
  await loadSkills();

  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  const transport = process.env.TRANSPORT || 'cli';

  switch (transport) {
    case 'http':
      await startHTTPServer();
      break;
    case 'feishu':
      await startFeishuAdapter();
      break;
    default:
      await startCLIAdapter(args.sessionId, args.provider);
  }
}

/**
 * 启动 HTTP 服务器
 */
async function startHTTPServer(): Promise<void> {
  const port = Number(process.env.HTTP_PORT) || DEFAULT_HTTP_PORT;
  const userId = await getUserId();
  const llmClient = createLLMClientFromEnv();
  const sessionManager = createSessionManager({
    store: new JSONLStore({ dir: DEFAULT_SESSION_DIR }),
    maxContextMessages: 40,
  });

  initMemoryWithLLM(llmClient);
  sessionManager.setLLMClient(llmClient);

  registerDefaultTools(llmClient);

  const permissionService = createPermissionServiceFromEnv();
  const mediaConfig = loadMediaConfigFromEnv();

  const adapter = new HTTPChannelAdapter({ port });
  const messageHandler = createMessageHandler({
    llmClient,
    sessionManager,
    mediaConfig,
  });

  adapter.setMessageHandler(async (message, callbacks) => {
    const permission = await permissionService.checkPermission(message);
    if (!permission.allowed) {
      return {
        id: `resp-${Date.now()}`,
        messageId: message.id,
        content: [
          { type: 'text', text: `Permission denied: ${permission.reason}` },
        ],
        timestamp: Date.now(),
        done: true,
      };
    }
    return messageHandler(message, callbacks);
  });

  adapter.setSessionListHandler(async () => {
    const sessions = await sessionManager.list();
    return { sessions };
  });

  const httpResultSender: CronResultSender = async (result, context) => {
    await adapter.send(
      {
        id: `cron-${Date.now()}`,
        messageId: '',
        content: [{ type: 'text', text: result }],
        timestamp: Date.now(),
        done: true,
      },
      context,
    );
  };

  const cronScheduler = initCronScheduler({
    llmClient,
    messageHandler,
    resultSender: httpResultSender,
  });
  await cronScheduler.start();

  await adapter.initialize();
  log.info(`HTTP server started on port ${port}`);

  process.on('SIGINT', async () => {
    log.info('Shutting down...');
    await cronScheduler.stop();
    await adapter.close();
    process.exit(0);
  });
}

/**
 * 启动飞书适配器
 */
async function startFeishuAdapter(): Promise<void> {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error(
      'FEISHU_APP_ID and FEISHU_APP_SECRET are required for feishu transport',
    );
  }

  const userId = await getUserId();
  const llmClient = createLLMClientFromEnv();
  const sessionManager = createSessionManager({
    store: new JSONLStore({ dir: DEFAULT_SESSION_DIR }),
    maxContextMessages: 40,
  });

  initMemoryWithLLM(llmClient);
  const memory = getMemory();
  memory.setUserId(userId);
  sessionManager.setLLMClient(llmClient);

  registerDefaultTools(llmClient);

  const permissionService = createPermissionServiceFromEnv();
  const mediaConfig = loadMediaConfigFromEnv();

  const feishuConfig: FeishuAdapterConfig = {
    appId,
    appSecret,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY,
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
    enableStreamingCard: process.env.ENABLE_STREAMING_CARD === 'true',
    useLark: process.env.FEISHU_USE_LARK === 'true',
  };

  const adapter = new FeishuChannelAdapter(feishuConfig);
  const messageHandler = createMessageHandler({
    llmClient,
    sessionManager,
    mediaConfig,
    getAbortSignal: (chatId?: string) =>
      chatId ? adapter.getAbortSignal(chatId) : undefined,
  });

  adapter.setMessageHandler(async (message, callbacks) => {
    const permission = await permissionService.checkPermission(message);
    if (!permission.allowed) {
      return {
        id: `resp-${Date.now()}`,
        messageId: message.id,
        content: [
          { type: 'text', text: `Permission denied: ${permission.reason}` },
        ],
        timestamp: Date.now(),
        done: true,
      };
    }
    return messageHandler(message, callbacks);
  });

  const resultSender = async (
    result: string,
    context: import('./transport/unified.js').MessageContext,
  ) => {
    await adapter.send(
      {
        id: `cron-${Date.now()}`,
        messageId: '',
        content: [{ type: 'text', text: result }],
        timestamp: Date.now(),
        done: true,
      },
      context,
    );
  };

  const cronScheduler = initCronScheduler({
    llmClient,
    messageHandler,
    resultSender,
  });
  await cronScheduler.start();

  async function stopSkillsWatcher(): Promise<void> {
    try {
      const loader = getGlobalLoader();
      loader.stopWatching();
    } catch (error) {
      log.warn(`Failed to stop skills watcher: ${error}`);
    }
  }

  async function shutdown(adapter?: { close(): Promise<void> }): Promise<void> {
    log.info('Shutting down...');
    await stopSkillsWatcher();
    await cronScheduler.stop();
    if (adapter) {
      await adapter.close();
    }
    process.exit(0);
  }

  await adapter.initialize();
  log.info('Feishu adapter started');

  process.on('SIGINT', () => shutdown(adapter));
}

/**
 * 启动 CLI 适配器
 */
async function startCLIAdapter(
  sessionId?: string,
  providerName?: string,
): Promise<void> {
  const userId = await getUserId();
  const llmClient = createLLMClientFromEnv(providerName);
  const sessionManager = createSessionManager({
    store: new JSONLStore({ dir: DEFAULT_SESSION_DIR }),
    maxContextMessages: 40,
  });
  sessionManager.setLLMClient(llmClient);

  initMemoryWithLLM(llmClient);
  const memory = getMemory();
  memory.setUserId(userId);

  // registerDefaultTools();

  const sid = sessionId || `session-${Date.now()}`;
  const initialMessages = await sessionManager.load(sid);

  if (initialMessages.length > 0) {
    console.log(`Loaded session: ${sid}`);
    console.log(`Messages: ${initialMessages.length}`);
    console.log('');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let abortController: AbortController | null = null;

  const confirmFn = async (preview: string): Promise<boolean> => {
    return new Promise((resolve) => {
      rl.question(`\n[confirm] ${preview}\nProceed? [y/N] `, (answer) => {
        resolve(answer.toLowerCase() === 'y');
      });
    });
  };

  const permissionService = createPermissionServiceFromEnv();
  const mediaConfig = loadMediaConfigFromEnv();

  const adapter = new CLIChannelAdapter({
    sessionId: sid,
    welcomeMessage: `Agent CLI\nSession: ${sid}\nType "exit" to quit.`,
    sessionManager,
    memory,
    rl,
    abort: () => abortController?.abort(),
  });

  const messageHandler = createMessageHandler({
    llmClient,
    sessionManager,
    confirmFn,
    onText: (delta) => process.stdout.write(delta),
    mediaConfig,
    getAbortSignal: () => abortController?.signal,
  });

  adapter.setMessageHandler(async (message) => {
    abortController = new AbortController();
    adapter.setAbortController(abortController);

    const permission = await permissionService.checkPermission(message);
    if (!permission.allowed) {
      adapter.setAbortController(null);
      return {
        id: `resp-${Date.now()}`,
        messageId: message.id,
        content: [
          { type: 'text', text: `Permission denied:${permission.reason}` },
        ],
        timestamp: Date.now(),
        done: true,
      };
    }

    try {
      const response = await messageHandler(message);
      return response;
    } finally {
      adapter.setAbortController(null);
    }
  });

  await adapter.initialize();
  await adapter.start();
}

// ─── Start Application ──────────────────────────────────────────────────────

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
