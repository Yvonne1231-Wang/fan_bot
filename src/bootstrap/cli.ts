// ─── CLI Adapter Bootstrap ───────────────────────────────────────────────────

import { createDebug } from '../utils/debug.js';
import { createInterface } from 'readline';
import { getUserId } from '../user/index.js';
import { createLLMClientFromEnv } from '../llm/index.js';
import { createSessionManager, JSONLStore } from '../session/index.js';
import { getMemory } from '../memory/index.js';
import { CLIChannelAdapter } from '../transport/index.js';
import { createPermissionServiceFromEnv } from '../permission/index.js';
import { loadMediaConfigFromEnv } from '../media-understanding/index.js';

const log = createDebug('bootstrap:cli');
import { createMessageHandler } from '../handler.js';
import { runWithContext } from '../tools/registry.js';
import {
  DEFAULT_SESSION_DIR,
  getCachedSkillEntries,
  registerDefaultTools,
  initMemoryWithLLM,
  initObservabilityFromEnv,
  initSandboxFromEnv,
  cleanupSandbox,
} from './shared.js';

/**
 * 启动 CLI 适配器
 */
export async function startCLIAdapter(
  sessionId?: string,
  providerName?: string,
): Promise<void> {
  const userId = await getUserId();
  const llmClient = createLLMClientFromEnv(providerName);

  initObservabilityFromEnv();

  await initSandboxFromEnv();

  const sessionManager = createSessionManager({
    store: new JSONLStore({ dir: DEFAULT_SESSION_DIR }),
    maxContextMessages: 40,
  });
  sessionManager.setLLMClient(llmClient);

  await initMemoryWithLLM(llmClient);
  const memory = getMemory();
  memory.setUserId(userId);

  await registerDefaultTools(llmClient);

  const sid = sessionId || `session-${Date.now()}`;
  const initialMessages = await sessionManager.load(sid);

  if (initialMessages.length > 0) {
    log.info(`Loaded session: ${sid}`);
    log.info(`Messages: ${initialMessages.length}`);
    log.info('');
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
    getSkillEntries: getCachedSkillEntries,
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
      // 使用 runWithContext 隔离工具上下文，确保工具能获取当前请求信息
      const ctx = {
        channel: message.context.channel,
        userId: message.context.userId,
        sessionId: message.context.sessionId,
        chatId: message.context.dmId,
      };
      const response = await runWithContext(ctx, () => messageHandler(message));
      return response;
    } finally {
      adapter.setAbortController(null);
    }
  });

  await adapter.initialize();
  await adapter.start();

  process.on('SIGINT', async () => {
    log.info('Shutting down...');
    await cleanupSandbox();
    process.exit(0);
  });
}
