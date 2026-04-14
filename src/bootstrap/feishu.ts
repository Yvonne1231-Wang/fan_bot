// ─── Feishu Adapter Bootstrap ────────────────────────────────────────────────

import { getUserId } from '../user/index.js';
import { createLLMClientFromEnv } from '../llm/index.js';
import { createSessionManager, JSONLStore } from '../session/index.js';
import { getMemory } from '../memory/index.js';
import { createPermissionServiceFromEnv } from '../permission/index.js';
import { loadMediaConfigFromEnv } from '../media-understanding/index.js';
import {
  FeishuChannelAdapter,
  type FeishuAdapterConfig,
} from '../feishu/index.js';
import { createMessageHandler } from '../handler.js';
import type { MessageContext } from '../transport/unified.js';
import {
  DEFAULT_SESSION_DIR,
  getCachedSkillEntries,
  registerDefaultTools,
  initMemoryWithLLM,
  initCronScheduler,
  stopSkillsWatcher,
} from './shared.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('bootstrap:feishu');

/**
 * 启动飞书适配器
 */
export async function startFeishuAdapter(): Promise<void> {
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

  await initMemoryWithLLM(llmClient);
  const memory = getMemory();
  memory.setUserId(userId);
  sessionManager.setLLMClient(llmClient);

  await registerDefaultTools(llmClient);

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
    getSkillEntries: getCachedSkillEntries,
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

  const resultSender = async (result: string, context: MessageContext) => {
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

  async function shutdown(feishuAdapter?: {
    close(): Promise<void>;
  }): Promise<void> {
    log.info('Shutting down...');
    await stopSkillsWatcher();
    await cronScheduler.stop();
    if (feishuAdapter) {
      await feishuAdapter.close();
    }
    process.exit(0);
  }

  await adapter.initialize();
  log.info('Feishu adapter started');

  process.on('SIGINT', () => shutdown(adapter));
}
