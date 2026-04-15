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
    onPendingSkillFound: (candidate, messageId) => {
      const confidence = (candidate.confidence * 100).toFixed(0);
      const text = `💡 检测到可复用的工作流模式「${candidate.name}」(置信度 ${confidence}%)\n\n${candidate.description}\n\n回复 "确认安装 ${candidate.name}" 保存为技能，或 "丢弃 ${candidate.name}" 忽略。`;
      adapter.send(
        {
          id: `skill-notify-${Date.now()}`,
          messageId: '',
          content: [{ type: 'text', text }],
          timestamp: Date.now(),
          done: true,
        },
        {
          channel: 'feishu',
          userId: 'system',
          sessionId: 'skill-notify',
          metadata: {
            originalMessageId: messageId,
          },
        },
      ).catch((err) => {
        log.error(`Failed to send skill candidate notification: ${err}`);
      });
    },
    onSkillImproveSuggested: (suggestion, messageId) => {
      const text = `\u{1F527} 技能「${suggestion.skillName}」可能需要改进\n\n原因：${suggestion.reason}\n\n建议：${suggestion.suggestedFeedback}\n\n回复 "改进 ${suggestion.skillName}" 自动优化，或忽略此消息。`;
      adapter.send(
        {
          id: `skill-improve-${Date.now()}`,
          messageId: '',
          content: [{ type: 'text', text }],
          timestamp: Date.now(),
          done: true,
        },
        {
          channel: 'feishu',
          userId: 'system',
          sessionId: 'skill-improve',
          metadata: {
            originalMessageId: messageId,
          },
        },
      ).catch((err) => {
        log.error(`Failed to send skill improve notification: ${err}`);
      });
    },
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
    defaultNotifyChatId: process.env.SKILL_NOTIFY_CHAT_ID,
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
