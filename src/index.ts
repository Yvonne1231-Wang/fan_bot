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
import {
  CLIChannelAdapter,
  HTTPChannelAdapter,
  parseArgs,
  printHelp,
  type UnifiedMessage,
  type UnifiedResponse,
  type MessageHandler,
} from './transport/index.js';
import { createPermissionService } from './permission/index.js';
import {
  FeishuChannelAdapter,
  type FeishuAdapterConfig,
} from './feishu/index.js';
import { createDebug } from './utils/debug.js';

const log = createDebug('main');

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SESSION_DIR = './sessions';
const DEFAULT_HTTP_PORT = 3000;

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
}): MessageHandler {
  const { llmClient, sessionManager, confirmFn, onText } = options;
  const memory = getMemory();

  return async (
    message: UnifiedMessage,
    callbacks?: AgentCallbacks,
  ): Promise<UnifiedResponse> => {
    const sessionId = message.context.sessionId;
    const userId = message.context.userId;

    // 为每个用户设置独立的记忆上下文
    if (userId && memory instanceof LanceDBMemoryService) {
      memory.setUserId(userId);
    }

    const userQuery = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');

    const messages = await sessionManager.load(sessionId);
    const systemPrompt = await buildSystemPrompt({
      agentName: 'fan_bot',
      memory,
      userQuery,
    });

    let responseText = '';

    if (shouldPlan(userQuery)) {
      const plan = await createPlan(userQuery, llmClient);
      let lastResult = '';

      for (const step of plan.steps) {
        step.status = 'running';
        const result = await runAgent({
          prompt: `${step.title}\n\nContext from previous steps:\n${lastResult}`,
          llmClient,
          toolRegistry: registry,
          initialMessages: messages,
          maxIterations: 100,
          systemPrompt,
          confirmFn,
          callbacks,
        });
        step.status = 'done';
        step.result = result.response;
        lastResult = result.response;
        await sessionManager.save(sessionId, result.messages);
      }

      responseText = `Plan complete.\n\nFinal result:\n${lastResult}`;
    } else {
      const result = await runAgent({
        prompt: userQuery,
        llmClient,
        toolRegistry: registry,
        initialMessages: messages,
        maxIterations: 100,
        systemPrompt,
        onText,
        confirmFn,
        callbacks,
      });

      responseText = result.response;
      await sessionManager.save(sessionId, result.messages);

      setImmediate(async () => {
        try {
          const compressed = await sessionManager.compress(result.messages);
          await sessionManager.save(sessionId, compressed);

          if (result.messages.length >= 2) {
            const extraction = await extractMemories(
              result.messages.slice(-2),
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

  registerTool(calculatorTool);
  registerTool(readFileTool);
  registerTool(writeFileTool);
  registerTool(listDirTool);
  registerTool(shellTool);
  registerTool(webSearchTool);
  registerTool(webFetchTool);

  const permissionService = createPermissionService({
    admins: process.env.ADMINS?.split(',') || [],
  });

  const adapter = new HTTPChannelAdapter({ port });
  const messageHandler = createMessageHandler({ llmClient, sessionManager });

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

  await adapter.initialize();
  log.info(`HTTP server started on port ${port}`);
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

  registerTool(calculatorTool);
  registerTool(readFileTool);
  registerTool(writeFileTool);
  registerTool(listDirTool);
  registerTool(shellTool);
  registerTool(webSearchTool);
  registerTool(webFetchTool);

  const permissionService = createPermissionService({
    admins: process.env.ADMINS?.split(',') || [],
    group: {
      defaultPolicy: 'whitelist',
      whitelist: process.env.FEISHU_GROUP_WHITELIST?.split(',') || [],
      blacklist: [],
      allowedTools: [],
      forbiddenTools: [],
      allowMention: true,
      allowDirectCall: process.env.FEISHU_ALLOW_DIRECT_CALL === 'true',
    },
  });

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

  await adapter.initialize();
  log.info('Feishu adapter started');

  process.on('SIGINT', async () => {
    log.info('Shutting down...');
    await adapter.close();
    process.exit(0);
  });
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

  registerTool(calculatorTool);
  registerTool(readFileTool);
  registerTool(writeFileTool);
  registerTool(listDirTool);
  registerTool(shellTool);
  registerTool(webSearchTool);
  registerTool(webFetchTool);

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

  const permissionService = createPermissionService({
    admins: process.env.ADMINS?.split(',') || [],
  });

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
  });

  adapter.setMessageHandler(async (message) => {
    abortController = new AbortController();

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

    return messageHandler(message);
  });

  await adapter.initialize();
  await adapter.start();
}

// ─── Start Application ──────────────────────────────────────────────────────

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
