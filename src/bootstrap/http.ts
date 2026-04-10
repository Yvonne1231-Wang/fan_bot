// ─── HTTP Server Bootstrap ──────────────────────────────────────────────────

import { createLLMClientFromEnv } from '../llm/index.js';
import { createSessionManager, JSONLStore } from '../session/index.js';
import { HTTPChannelAdapter } from '../transport/index.js';
import { createPermissionServiceFromEnv } from '../permission/index.js';
import { loadMediaConfigFromEnv } from '../media-understanding/index.js';
import { createMessageHandler } from '../handler.js';
import type { CronResultSender } from '../cron/index.js';
import {
  DEFAULT_SESSION_DIR,
  DEFAULT_HTTP_PORT,
  getCachedSkillEntries,
  registerDefaultTools,
  initMemoryWithLLM,
  initCronScheduler,
} from './shared.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('bootstrap:http');

/**
 * 启动 HTTP 服务器
 */
export async function startHTTPServer(): Promise<void> {
  const port = Number(process.env.HTTP_PORT) || DEFAULT_HTTP_PORT;
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
    getSkillEntries: getCachedSkillEntries,
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
