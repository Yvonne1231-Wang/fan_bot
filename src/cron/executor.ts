/**
 * Cron Task Executor - 按任务类型分发执行
 */

import type {
  CronTask,
  AgentTaskPayload,
  NotificationTaskPayload,
  ShellTaskPayload,
  SkillNotifyPayload,
  CronExecutionResult,
} from './types.js';
import type { LLMClient, AgentCallbacks } from '../llm/types.js';
import type { ToolRegistry } from '../tools/types.js';
import type { MessageHandler } from '../transport/adapter.js';
import type { MemoryService } from '../memory/types.js';
import type { PermissionService } from '../permission/index.js';
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
import { validateShellCommand, SecurityError } from './security.js';
import { getErrorMessage } from '../utils/error.js';

const execFileAsync = promisify(execFile);

const log = createDebug('cron:executor');

const DEFAULT_CRON_MAX_ITERATIONS = 10;
const DEFAULT_CRON_TIMEOUT_MS = 300_000;

/**
 * 构造 cron Agent 的 callbacks：
 * 当某个工具连续 2 次返回"空数据 / 认证失败"特征字符串时，
 * 通过传入的 AbortController 立即终止 Agent 循环，避免无效重试烧 token。
 *
 * 注意：每次调用返回独立闭包实例，内部状态（计数器）不会跨任务污染。
 */
function buildCronAbortOnEmptyCallbacks(
  hardStopController: AbortController,
): AgentCallbacks {
  const EMPTY_RESULT_THRESHOLD = 2;
  // 空数据 / 认证失败的通用特征串（不绑定具体 skill）
  const emptyPatterns: RegExp[] = [
    /"hidden"\s*:\s*true/i,
    /"hidingReason"/i,
    /\b(无数据|菜单走丢|暂未发布|no\s+data|empty)\b/i,
    /missing\s+access\s+token/i,
    /mina\s+login\s+failed/i,
    /\b(unauthorized|401|403)\b/i,
    /"error"\s*:/i,
  ];

  let consecutiveEmpty = 0;

  return {
    onToolEnd: (toolName: string, output: string) => {
      const text = String(output ?? '');
      const matched = emptyPatterns.some((re) => re.test(text));
      if (matched) {
        consecutiveEmpty += 1;
        log.warn(
          `Cron agent tool "${toolName}" returned empty/auth-failure (${consecutiveEmpty}/${EMPTY_RESULT_THRESHOLD})`,
        );
        if (consecutiveEmpty >= EMPTY_RESULT_THRESHOLD) {
          log.error(
            `Cron agent hard-stop: consecutive empty/auth failures reached threshold, aborting`,
          );
          hardStopController.abort();
        }
      } else {
        consecutiveEmpty = 0;
      }
    },
  };
}

export interface CronResultSender {
  (result: string, context: MessageContext): Promise<void>;
}

export interface CronExecutorOptions {
  llmClient: LLMClient;
  toolRegistry: ToolRegistry;
  memory?: MemoryService;
  notificationHandler?: MessageHandler;
  resultSender?: CronResultSender;
  permissionService?: PermissionService;
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
          result = await this.executeShell(
            task.payload as ShellTaskPayload,
            task.createdBy,
          );
          break;
        case 'skill-notify':
          result = await this.executeSkillNotify(
            task.payload as SkillNotifyPayload,
          );
          break;
        default:
          throw new Error(`Unknown task type: ${task.type}`);
      }

      const executedAt = Date.now();
      log.info(
        `Cron task completed: ${task.name} (${executedAt - startTime}ms)`,
      );

      if (
        context &&
        this.options.resultSender &&
        task.type !== 'skill-notify'
      ) {
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

      await this.notifyCreator(task, `✅ 定时任务「${task.name}」已完成`);

      return {
        taskId: task.id,
        success: true,
        result,
        executedAt,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error(`Cron task failed: ${task.name} - ${errorMessage}`);

      await this.notifyCreator(
        task,
        `❌ 定时任务「${task.name}」执行失败：${errorMessage}`,
      );

      return {
        taskId: task.id,
        success: false,
        error: errorMessage,
        executedAt: Date.now(),
      };
    }
  }

  /**
   * 发送任务完成通知到创建者的私聊
   *
   * 使用 createdBy（飞书 open_id）作为接收目标，
   * receiveIdType 设为 open_id 以确保消息发送到私聊窗口。
   */
  private async notifyCreator(task: CronTask, message: string): Promise<void> {
    if (!task.createdBy || !this.options.resultSender) {
      return;
    }

    if (task.type === 'skill-notify') {
      return;
    }

    const creatorContext: MessageContext = {
      channel: 'feishu',
      userId: 'cron-system',
      sessionId: `cron-notify-${task.id}`,
      metadata: {
        chatId: task.createdBy,
        receiveIdType: 'open_id',
      },
    };

    try {
      await this.options.resultSender(message, creatorContext);
      log.info(`Completion notification sent to creator: ${task.createdBy}`);
    } catch (notifyError) {
      const notifyErrorMsg =
        notifyError instanceof Error
          ? notifyError.message
          : String(notifyError);
      log.error(
        `Failed to send completion notification to creator: ${notifyErrorMsg}`,
      );
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
    const { llmClient, toolRegistry, memory, permissionService } = this.options;

    const effectiveUserId = userId || 'cron-system';
    const ctx = {
      channel: 'cron',
      userId: effectiveUserId,
      sessionId,
      chatId: sessionId,
    };

    /**
     * 构造权限检查上下文，以任务创建者身份检查工具权限
     * cron-system / system 用户在 checkToolPermission 中直接放行
     */
    const messageContext: import('../transport/unified.js').MessageContext = {
      channel: 'http',
      userId: effectiveUserId,
      sessionId,
      metadata: {},
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

      // Cron 模式下给 Agent 的强约束 prompt
      // 设计目标：让 Agent 专注业务目标，失败即停、不乱搞凭据/环境，消息发送交还 resultSender
      const cronGuidance = [
        '',
        '',
        '[Cron 执行模式]',
        '你是定时任务驱动的自主 Agent，没有用户在等待交互回复。请严格遵守以下规则：',
        '',
        '## 目标',
        '- 调用业务 skill / 工具完成任务；任务的"产出"是最终消息文本，由宿主进程统一发往飞书，你无需自行发送。',
        '',
        '## 发送渠道（重要）',
        '- 宿主进程已持有飞书发送通道，会在你返回最终文本后自动推送到目标群聊。',
        '- ⛔ 严禁自行 `curl` / `axios` / 写新脚本 调用飞书 OpenAPI 发消息。',
        '- ⛔ 严禁通过 shell 调用 `lark-cli`、`npm run feishu:*`、`security find-generic-password`、`security dump-keychain` 等尝试获取或刷新凭据。',
        '- ⛔ 严禁尝试登录飞书、刷新 token、修改 `.env` 或 keychain。',
        '',
        '## 失败处理（硬约束，违反即立刻停止）',
        '- 同一类工具返回"无数据 / 空结果 / 认证失败 / hidingReason"连续 2 次，立即停止重试，直接输出简短错误摘要作为最终结果并结束。',
        '- 明确的不可恢复错误（如 session 过期、token 缺失、API 403/401），立即以"❌ 原因 + 建议"格式结束，不要尝试自我修复。',
        '- 绝不编写新脚本来"绕过"当前的失败：跑不通就按失败结束。',
        '',
        '## 输出纪律',
        '- 完成任务后直接结束（stop_reason=end_turn），不要再额外迭代"确认一下"。',
        '- 最终回复只保留对群聊用户有价值的内容，不要夹带技能分析、风格建议、情绪机制等元讨论。',
      ].join('\n');

      // 硬终止机制：把 timeout 与"空数据硬停"合并到单个 AbortController
      // 作用域限定在本次 executeAgent 调用内，避免不同 cron 任务并发时相互干扰
      const hardStopController = new AbortController();
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      timeoutSignal.addEventListener(
        'abort',
        () => hardStopController.abort(),
        { once: true },
      );

      const result = await runAgent({
        prompt: payload.prompt,
        llmClient,
        toolRegistry,
        maxIterations,
        systemPrompt: systemPrompt + cronGuidance,
        abortSignal: hardStopController.signal,
        permissionService,
        messageContext,
        callbacks: buildCronAbortOnEmptyCallbacks(hardStopController),
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
   * 运行 shell 命令并返回输出，
   * 非管理员创建的任务会被权限检查拒绝
   */
  private async executeShell(
    payload: ShellTaskPayload,
    userId?: string,
  ): Promise<string> {
    const { permissionService } = this.options;
    const effectiveUserId = userId || 'cron-system';

    if (
      permissionService &&
      effectiveUserId !== 'cron-system' &&
      effectiveUserId !== 'system'
    ) {
      const access = await permissionService.checkToolPermission(
        {
          channel: 'http',
          userId: effectiveUserId,
          sessionId: `cron-shell-${Date.now()}`,
          metadata: {},
        },
        'shell',
      );
      if (!access.allowed) {
        throw new SecurityError(
          `Shell task denied for user ${effectiveUserId}: ${access.reason}`,
        );
      }
    }

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

  /**
   * 执行技能通知任务
   *
   * 扫描 .fan_bot/pending_skills/ 下的待确认技能，
   * 按 sourceChatId 分组推送到对应的飞书聊天窗口。
   * 无 sourceChatId 的技能合并到 payload.chatId 或 task.notificationTarget 推送。
   */
  private async executeSkillNotify(
    payload: SkillNotifyPayload,
  ): Promise<string> {
    const { listPendingSkills } = await import('../skills/extractor.js');

    const pending = await listPendingSkills();

    if (pending.length === 0) {
      log.debug('No pending skills to notify');
      return 'No pending skills to notify.';
    }

    const summaryLines: string[] = [];
    summaryLines.push(
      `Scanned ${pending.length} pending skills, sending notifications...`,
    );

    const byChat = new Map<string, typeof pending>();
    const noChat: typeof pending = [];

    for (const p of pending) {
      const chatId = p.sourceChatId || payload.chatId;
      if (chatId) {
        if (!byChat.has(chatId)) {
          byChat.set(chatId, []);
        }
        byChat.get(chatId)!.push(p);
      } else {
        noChat.push(p);
      }
    }

    const resultSender = this.options.resultSender;

    if (resultSender) {
      for (const [chatId, items] of byChat) {
        const message = this.formatSkillNotifyMessage(items);
        const ctx: MessageContext = {
          channel: 'feishu',
          userId: 'cron-system',
          sessionId: `skill-notify-${chatId}`,
          metadata: {
            chatId,
            receiveIdType: payload.receiveIdType || 'chat_id',
          },
        };

        try {
          await resultSender(message, ctx);
          summaryLines.push(
            `  → Sent ${items.length} skills to chat ${chatId}`,
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          summaryLines.push(`  → Failed to send to chat ${chatId}: ${msg}`);
          log.error(`Failed to send skill notify to ${chatId}: ${msg}`);
        }
      }
    }

    if (noChat.length > 0) {
      summaryLines.push(
        `  ⚠ ${noChat.length} skills have no target chatId, skipped push: ${noChat.map((p) => p.candidate.name).join(', ')}`,
      );
    }

    return summaryLines.join('\n');
  }

  /**
   * 格式化技能通知消息
   */
  private formatSkillNotifyMessage(
    items: Array<{
      candidate: {
        name: string;
        description: string;
        reason: string;
        confidence: number;
      };
      createdAt: number;
    }>,
  ): string {
    const lines: string[] = [];
    lines.push(`🆕 发现 ${items.length} 个待确认的自动提取技能：`);
    lines.push('');

    for (const p of items) {
      const confidence = (p.candidate.confidence * 100).toFixed(0);
      const age = Math.floor((Date.now() - p.createdAt) / (60 * 60 * 1000));
      const ageText =
        age < 1
          ? '刚刚'
          : age < 24
            ? `${age}小时前`
            : `${Math.floor(age / 24)}天前`;

      lines.push(
        `▸ ${p.candidate.name}（置信度 ${confidence}%，${ageText}提取）`,
      );
      lines.push(`  ${p.candidate.description}`);
      lines.push(`  原因：${p.candidate.reason}`);
      lines.push('');
    }

    lines.push('回复以下命令操作：');
    for (const p of items) {
      lines.push(
        `  ✅ 确认安装：Skill(action="confirm", skill_name="${p.candidate.name}")`,
      );
      lines.push(
        `  ❌ 拒绝丢弃：Skill(action="reject", skill_name="${p.candidate.name}")`,
      );
    }

    return lines.join('\n');
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
