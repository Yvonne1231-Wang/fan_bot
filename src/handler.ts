// ─── Message Handler ────────────────────────────────────────────────────────

import type { LLMClient, AgentCallbacks } from './llm/types.js';
import type { UnifiedMessage, UnifiedResponse } from './transport/unified.js';
import type { MessageHandler } from './transport/adapter.js';
import type { MediaConfig } from './media-understanding/types.js';
import type { SkillEntry, SkillCandidate } from './skills/types.js';
import type { SessionManager } from './session/types.js';
import {
  runAgent,
  buildSystemPrompt,
  createPlan,
  shouldPlan,
  extractMemories,
} from './agent/index.js';
import { registry } from './tools/registry.js';
import { getMemory } from './memory/index.js';
import type { PermissionService } from './permission/index.js';
import {
  runMediaUnderstanding,
  unifiedToMsgContext,
} from './media-understanding/index.js';
import { createDebug } from './utils/debug.js';
import { updateProfileFromConversation } from './user/profile-updater.js';
import {
  countToolUses,
  hasExplicitSkillRequest,
  evaluateForSkill,
  extractSkill,
  savePendingSkill,
  cleanupExpiredPending,
  extractUsedSkills,
  evaluateForImprovement,
} from './skills/extractor.js';
import type { ImproveSuggestion } from './skills/extractor.js';
import {
  createTrace,
  updateTrace,
  isObservabilityEnabled,
} from './observability/index.js';

const log = createDebug('handler');

const DEFAULT_MAX_AGENT_ITERATIONS = 20;
const BACKGROUND_TASK_MAX_RETRIES = 2;
const BACKGROUND_TASK_RETRY_DELAY_MS = 1000;

/**
 * 在后台执行异步任务，失败时自动重试
 *
 * @param taskName - 任务名称（用于日志标识）
 * @param fn - 要执行的异步函数
 * @param maxRetries - 最大重试次数
 */
function runBackgroundTask(
  taskName: string,
  fn: () => Promise<void>,
  maxRetries: number = BACKGROUND_TASK_MAX_RETRIES,
): void {
  setImmediate(async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await fn();
        return;
      } catch (error) {
        if (attempt < maxRetries) {
          log.warn(
            `Background task "${taskName}" failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying: ${error}`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, BACKGROUND_TASK_RETRY_DELAY_MS * (attempt + 1)),
          );
        } else {
          log.error(
            `Background task "${taskName}" failed after ${maxRetries + 1} attempts: ${error}`,
          );
        }
      }
    }
  });
}

/**
 * 消息处理器配置选项
 */
export interface MessageHandlerOptions {
  llmClient: LLMClient;
  sessionManager: SessionManager;
  confirmFn?: (preview: string) => Promise<boolean>;
  onText?: (delta: string) => void;
  mediaConfig?: MediaConfig;
  getAbortSignal?: (chatId?: string) => AbortSignal | undefined;
  getSkillEntries: () => SkillEntry[];
  onPendingSkillFound?: (candidate: SkillCandidate, messageId: string) => void;
  onSkillImproveSuggested?: (
    suggestion: ImproveSuggestion,
    messageId: string,
  ) => void;
  permissionService?: PermissionService;
}

/**
 * 创建消息处理器
 *
 * 将用户消息通过 Agent 循环处理并返回响应，
 * 包含多媒体理解、计划拆解、记忆提取等完整流程。
 *
 * @param options - 处理器配置选项
 * @returns 消息处理器函数
 */
export function createMessageHandler(
  options: MessageHandlerOptions,
): MessageHandler {
  const {
    llmClient,
    sessionManager,
    confirmFn,
    onText,
    mediaConfig,
    getAbortSignal,
    getSkillEntries,
    onPendingSkillFound,
    onSkillImproveSuggested,
    permissionService,
  } = options;
  const memory = getMemory();

  return async (
    message: UnifiedMessage,
    callbacks?: AgentCallbacks,
  ): Promise<UnifiedResponse> => {
    const sessionId = message.context.sessionId;
    const userId = message.context.userId;
    const sourceChatId =
      message.context.groupId ||
      (message.context.metadata.chatId as string | undefined) ||
      message.context.dmId;

    const trace = createTrace({
      name: 'message-handler',
      sessionId,
      userId,
      input: message.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n'),
      metadata: {
        channel: message.context.channel,
        groupId: message.context.groupId,
      },
    });

    if (userId) {
      memory.setUserId(userId);
    }

    const userQuery = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');

    const [messages, mediaResult] = await Promise.all([
      sessionManager.load(sessionId),
      mediaConfig
        ? runMediaUnderstanding(unifiedToMsgContext(message), mediaConfig)
        : Promise.resolve(undefined),
    ]);

    const channelInfo = [
      `Channel: ${message.context.channel}`,
      message.context.groupId
        ? `Chat type: group (id: ${message.context.groupId})`
        : 'Chat type: direct message',
      `User ID: ${userId}`,
    ].join('\n');

    const systemPrompt = await buildSystemPrompt({
      agentName: 'fan_bot',
      memory,
      userQuery,
      skills: getSkillEntries(),
      extraContext: channelInfo,
      userId,
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
      // 使用可变引用追踪累积的消息，避免 step 间 context 丢失
      let currentMessages = messages;

      for (const step of plan.steps) {
        step.status = 'running';
        const result = await runAgent({
          prompt: `${step.title}\n\nContext from previous steps:\n${lastResult}`,
          llmClient,
          toolRegistry: registry,
          initialMessages: currentMessages,
          maxIterations:
            Number(process.env.MAX_AGENT_ITERATIONS) ||
            DEFAULT_MAX_AGENT_ITERATIONS,
          systemPrompt,
          confirmFn,
          callbacks,
          abortSignal: getAbortSignal?.(
            message.context.metadata.chatId as string,
          ),
          trace: trace ?? undefined,
          permissionService,
          messageContext: message.context,
        });
        step.status = 'done';
        step.result = result.response;
        lastResult = result.response;
        // 累积 messages，下一个 step 能看到之前的对话上下文
        currentMessages = result.messages;
      }

      // Plan 完成后统一保存最终累积的消息
      await sessionManager.save(sessionId, currentMessages);

      responseText = `Plan complete.\n\nFinal result:\n${lastResult}`;

      // 后台压缩 session，与非 plan 模式一致
      runBackgroundTask('plan-session-compress', async () => {
        const compressed = await sessionManager.compress(currentMessages);
        await sessionManager.save(sessionId, compressed);
      });

      runBackgroundTask('plan-memory-extract', async () => {
        if (memory) {
          const extraction = await extractMemories(
            currentMessages.slice(-8),
            llmClient,
            memory,
          );
          if (extraction.extracted.length > 0) {
            log.info(
              `Background: Auto-extracted ${extraction.extracted.length} memories from plan`,
            );
          }
        }
      });

      runBackgroundTask('plan-profile-update', async () => {
        if (userId) {
          await updateProfileFromConversation(
            currentMessages.slice(-8),
            llmClient,
            userId,
          );
        }
      });

      runBackgroundTask('plan-skill-evaluate', async () => {
        const toolUseCount = countToolUses(currentMessages);
        if (toolUseCount < 3 && !hasExplicitSkillRequest(userQuery)) return;

        const candidate = await evaluateForSkill(currentMessages, llmClient);
        if (!candidate) return;

        const draft = await extractSkill(currentMessages, candidate, llmClient);
        await savePendingSkill({
          candidate,
          draft,
          createdAt: Date.now(),
          sourceChatId,
        });

        onPendingSkillFound?.(candidate, message.id);
      });
      runBackgroundTask('plan-skill-improve-evaluate', async () => {
        const usedSkills = extractUsedSkills(currentMessages);
        if (usedSkills.length === 0) return;

        const suggestion = await evaluateForImprovement(
          currentMessages,
          usedSkills,
          llmClient,
        );
        if (suggestion) {
          onSkillImproveSuggested?.(suggestion, message.id);
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
        trace: trace ?? undefined,
        permissionService,
        messageContext: message.context,
      });

      responseText = result.response;
      await sessionManager.save(sessionId, result.messages);

      runBackgroundTask('session-compress', async () => {
        const compressed = await sessionManager.compress(result.messages);
        await sessionManager.save(sessionId, compressed);
      });

      runBackgroundTask('memory-extract', async () => {
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
      });

      runBackgroundTask('profile-update', async () => {
        if (userId && result.messages.length >= 2) {
          await updateProfileFromConversation(
            result.messages.slice(-8),
            llmClient,
            userId,
          );
        }
      });

      runBackgroundTask('skill-evaluate', async () => {
        const toolUseCount = countToolUses(result.messages);
        if (toolUseCount < 3 && !hasExplicitSkillRequest(userQuery)) return;

        const candidate = await evaluateForSkill(result.messages, llmClient);
        if (!candidate) return;

        const draft = await extractSkill(result.messages, candidate, llmClient);
        await savePendingSkill({
          candidate,
          draft,
          createdAt: Date.now(),
          sourceChatId,
        });

        onPendingSkillFound?.(candidate, message.id);
      });
      runBackgroundTask('skill-improve-evaluate', async () => {
        const usedSkills = extractUsedSkills(result.messages);
        if (usedSkills.length === 0) return;

        const suggestion = await evaluateForImprovement(
          result.messages,
          usedSkills,
          llmClient,
        );
        if (suggestion) {
          onSkillImproveSuggested?.(suggestion, message.id);
        }
      });

      // 清理过期的待确认技能
      runBackgroundTask('skill-cleanup', async () => {
        await cleanupExpiredPending();
      });
    }

    if (trace) {
      updateTrace(trace, {
        output: responseText.slice(0, 500),
      });
    }

    return {
      id: `resp-${Date.now()}`,
      messageId: message.id,
      content: [{ type: 'markdown' as const, text: responseText }],
      timestamp: Date.now(),
      done: true,
    };
  };
}
