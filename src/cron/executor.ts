/**
 * Cron Task Executor - 按任务类型分发执行
 */

import type {
  CronTask,
  AgentTaskPayload,
  NotificationTaskPayload,
  ShellTaskPayload,
  CronExecutionResult,
} from './types.js';
import type { LLMClient } from '../llm/types.js';
import type { ToolRegistry } from '../tools/types.js';
import type { MessageHandler } from '../transport/adapter.js';
import type { MemoryService } from '../memory/types.js';
import type {
  UnifiedMessage,
  UnifiedResponse,
  TextContentBlock,
  MessageContext,
} from '../transport/unified.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createDebug } from '../utils/debug.js';
import { runWithContext } from '../tools/registry.js';
import {
  validateShellCommand,
  isPathAllowed,
  SecurityError,
} from './security.js';

const execFileAsync = promisify(execFile);

const log = createDebug('cron:executor');

const DEFAULT_CRON_MAX_ITERATIONS = 20;
const DEFAULT_CRON_TIMEOUT_MS = 300_000;

export interface CronResultSender {
  (result: string, context: MessageContext): Promise<void>;
}

export interface CronExecutorOptions {
  llmClient: LLMClient;
  toolRegistry: ToolRegistry;
  memory?: MemoryService;
  notificationHandler?: MessageHandler;
  resultSender?: CronResultSender;
}

export class CronExecutor {
  private readonly options: CronExecutorOptions;

  constructor(options: CronExecutorOptions) {
    this.options = options;
  }

  /**
   * 执行单个 cron 任务
   *
   * @param task - 要执行的任务
   * @param context - 可选的发送上下文，用于将结果发送到飞书等渠道
   */
  async execute(
    task: CronTask,
    context?: MessageContext,
  ): Promise<CronExecutionResult> {
    log.info(`Executing cron task: ${task.name} (${task.type})`);

    const startTime = Date.now();

    try {
      let result: string;

      switch (task.type) {
        case 'agent':
          result = await this.executeAgent(
            task.payload as AgentTaskPayload,
            task.id,
            task.createdBy,
          );
          break;
        case 'notification':
          result = await this.executeNotification(
            task.payload as NotificationTaskPayload,
            task.id,
          );
          break;
        case 'shell':
          result = await this.executeShell(task.payload as ShellTaskPayload);
          break;
        default:
          throw new Error(`Unknown task type: ${task.type}`);
      }

      const executedAt = Date.now();
      log.info(
        `Cron task completed: ${task.name} (${executedAt - startTime}ms)`,
      );

      if (context && this.options.resultSender) {
        try {
          await this.options.resultSender(result, context);
          log.info(`Cron result sent to channel`);
        } catch (sendError) {
          const sendErrorMsg =
            sendError instanceof Error ? sendError.message : String(sendError);
          log.error(`Failed to send cron result: ${sendErrorMsg}`);
          return {
            taskId: task.id,
            success: false,
            error: `Result generated but delivery failed: ${sendErrorMsg}`,
            result,
            executedAt,
          };
        }
      }

      return {
        taskId: task.id,
        success: true,
        result,
        executedAt,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error(`Cron task failed: ${task.name} - ${errorMessage}`);

      return {
        taskId: task.id,
        success: false,
        error: errorMessage,
        executedAt: Date.now(),
      };
    }
  }

  /**
   * 执行 Agent 任务
   *
   * 将 prompt 交给 Agent 运行，返回结果
   */
  private async executeAgent(
    payload: AgentTaskPayload,
    sessionId: string,
    userId?: string,
  ): Promise<string> {
    const { llmClient, toolRegistry, memory } = this.options;

    // 注入用户 context，确保 memory 和工具能正确识别任务创建者
    const ctx = {
      channel: 'cron',
      userId: userId || 'cron-system',
      sessionId,
      chatId: sessionId,
    };

    return runWithContext(ctx, async () => {
    const { runAgent } = await import('../agent/loop.js');
    const { buildSystemPrompt } = await import('../agent/prompt.js');

    const systemPrompt = await buildSystemPrompt({
      agentName: 'fan_bot',
      memory,
      userQuery: payload.prompt,
      skills: [],
    });

    const maxIterations =
      Number(process.env.CRON_MAX_AGENT_ITERATIONS) ||
      DEFAULT_CRON_MAX_ITERATIONS;
    const timeoutMs =
      Number(process.env.CRON_AGENT_TIMEOUT_MS) || DEFAULT_CRON_TIMEOUT_MS;

    const cronGuidance = `\n\n[Cron 执行模式] 你是定时任务驱动的自主 Agent，没有用户在等待回复。你必须主动调用工具完成任务，不要只输出意图描述。如果需要搜索信息，请立即调用搜索工具；如果需要读取飞书消息，请立即调用相关工具。不要在第一次回复就结束——持续调用工具直到获取到完整结果。`;

    const result = await runAgent({
      prompt: payload.prompt,
      llmClient,
      toolRegistry,
      maxIterations,
      systemPrompt: systemPrompt + cronGuidance,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });

    return result.response;
    }); // runWithContext
  }

  /**
   * 执行通知任务
   *
   * 通过通知处理器发送消息
   */
  /**
   * executeNotification with context:
   *   - If context + resultSender are available: send directly via resultSender (Feishu push)
   *   - Otherwise: fall back to notificationHandler (agent pipeline) or console
   *
   * NOTE: This method is called by execute(), which already handles the resultSender
   * send-after-execution path. So here we just return the message text; the caller
   * routes it to Feishu.
   */
  private async executeNotification(
    payload: NotificationTaskPayload,
    taskId: string,
  ): Promise<string> {
    // Return the message text directly. The execute() wrapper will forward it
    // to resultSender when a context is present, which is the correct Feishu
    // delivery path. We only fall back to notificationHandler when no
    // resultSender is configured (e.g. CLI mode).
    const { notificationHandler, resultSender } = this.options;

    if (resultSender) {
      // Caller (execute()) will call resultSender(result, context) after we return.
      return payload.message;
    }

    if (!notificationHandler) {
      log.warn(`No notification handler for task ${taskId}, using console`);
      log.info(`[Notification] ${payload.message}`);
      return `Notification sent to console: ${payload.message}`;
    }

    // Legacy path: route through agent message pipeline (CLI/HTTP without resultSender)
    const content: TextContentBlock = { type: 'text', text: payload.message };
    const message: UnifiedMessage = {
      id: `notif-${taskId}-${Date.now()}`,
      context: {
        channel: 'http',
        userId: 'cron-system',
        sessionId: `cron-${taskId}`,
        metadata: {},
      },
      content: [content],
      timestamp: Date.now(),
    };

    const response: UnifiedResponse = await notificationHandler(message);

    const responseText =
      response.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('') || 'OK';

    return responseText;
  }

  /**
   * 执行 Shell 任务
   *
   * 运行 shell 命令并返回输出
   */
  private async executeShell(payload: ShellTaskPayload): Promise<string> {
    const timeout = payload.timeout || 60000;

    validateShellCommand(payload.command);

    // Split command into executable + args array to avoid shell injection
    const [executable, ...args] = payload.command.trim().split(/\s+/);

    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        timeout,
        maxBuffer: 5 * 1024 * 1024,
      });

      const output = [stdout, stderr].filter(Boolean).join('\n');
      return output || '(no output)';
    } catch (error: unknown) {
      if (error instanceof SecurityError) {
        throw error;
      }
      const execError = error as {
        code?: number;
        stderr?: string;
        message?: string;
      };
      const errorMsg = [
        `Exit code: ${execError.code ?? 1}`,
        execError.stderr || execError.message,
      ]
        .filter(Boolean)
        .join('\n');
      throw new Error(errorMsg);
    }
  }
}

let globalExecutor: CronExecutor | null = null;

export function getCronExecutor(options: CronExecutorOptions): CronExecutor {
  if (!globalExecutor) {
    globalExecutor = new CronExecutor(options);
  }
  return globalExecutor;
}

export function resetCronExecutor(): void {
  globalExecutor = null;
}
