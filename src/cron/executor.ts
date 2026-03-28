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
} from '../transport/unified.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createDebug } from '../utils/debug.js';
import {
  validateShellCommand,
  isPathAllowed,
  sanitizeShellArgument,
  SecurityError,
} from './security.js';

const execAsync = promisify(exec);

const log = createDebug('cron:executor');

export interface CronExecutorOptions {
  llmClient: LLMClient;
  toolRegistry: ToolRegistry;
  memory?: MemoryService;
  notificationHandler?: MessageHandler;
}

export class CronExecutor {
  private readonly options: CronExecutorOptions;

  constructor(options: CronExecutorOptions) {
    this.options = options;
  }

  /**
   * 执行单个 cron 任务
   */
  async execute(task: CronTask): Promise<CronExecutionResult> {
    log.info(`Executing cron task: ${task.name} (${task.type})`);

    const startTime = Date.now();

    try {
      let result: string;

      switch (task.type) {
        case 'agent':
          result = await this.executeAgent(
            task.payload as AgentTaskPayload,
            task.id,
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
  ): Promise<string> {
    const { llmClient, toolRegistry, memory } = this.options;

    const { runAgent } = await import('../agent/loop.js');
    const { buildSystemPrompt } = await import('../agent/prompt.js');

    const systemPrompt = await buildSystemPrompt({
      agentName: 'fan_bot',
      memory,
      userQuery: payload.prompt,
      skills: [],
    });

    const result = await runAgent({
      prompt: payload.prompt,
      llmClient,
      toolRegistry,
      maxIterations: 50,
      systemPrompt,
      abortSignal: AbortSignal.timeout(300000),
    });

    return result.response;
  }

  /**
   * 执行通知任务
   *
   * 通过通知处理器发送消息
   */
  private async executeNotification(
    payload: NotificationTaskPayload,
    taskId: string,
  ): Promise<string> {
    const { notificationHandler } = this.options;

    if (!notificationHandler) {
      log.warn(`No notification handler for task ${taskId}, using console`);
      console.log(`[Notification] ${payload.message}`);
      return `Notification sent to console: ${payload.message}`;
    }

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

    try {
      const sanitizedCommand = sanitizeShellArgument(payload.command);
      const { stdout, stderr } = await execAsync(sanitizedCommand, {
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
