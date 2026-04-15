// ─── Task Context ───────────────────────────────────────────────────────────
//
// 为子代理提供精简的任务上下文，而不是传递完整的对话历史。
// 包含：任务目标、共享上下文摘要、允许的工具列表。

import type { TeamTask, TeamAgent } from './types.js';
import { createDebug } from '../../utils/debug.js';

const debug = createDebug('agent:team:task-context');

export interface TaskContext {
  /** 任务 ID */
  taskId: string;
  /** 任务目标描述 */
  objective: string;
  /** 共享上下文摘要（来自 lead agent 或用户原始请求） */
  sharedContext: string;
  /** 前置任务的结果摘要 */
  dependencyResults: DependencyResult[];
  /** 允许使用的工具名称列表 */
  allowedTools: string[];
}

export interface DependencyResult {
  /** 前置任务名称 */
  taskName: string;
  /** 前置任务结果 */
  result: string;
}

/**
 * 从任务和完成的依赖中构建精简的 TaskContext。
 *
 * 设计理念：子代理只需要知道自己要做什么、背景是什么、前置任务产出了什么。
 * 不需要看到父级的完整对话历史。
 */
export function buildTaskContext(
  task: TeamTask,
  allTasks: TeamTask[],
  userGoal: string,
): TaskContext {
  const dependencyResults: DependencyResult[] = [];

  if (task.dependencies?.length) {
    for (const depId of task.dependencies) {
      const depTask = allTasks.find((t) => t.id === depId);
      if (depTask?.result) {
        dependencyResults.push({
          taskName: depTask.name ?? depTask.description.slice(0, 50),
          result: truncateResult(depTask.result, 2000),
        });
      }
    }
  }

  const allowedTools = task.assignee?.tools?.map((t) => t.name) ?? [];

  debug.debug(
    `Built TaskContext for "${task.name}": ${dependencyResults.length} deps, ${allowedTools.length} tools`,
  );

  return {
    taskId: task.id,
    objective: task.description,
    sharedContext: userGoal,
    dependencyResults,
    allowedTools,
  };
}

/**
 * 将 TaskContext 格式化为子代理的 prompt。
 * 这替代了之前简单的 buildTaskPrompt。
 */
export function formatTaskContextPrompt(ctx: TaskContext): string {
  const parts: string[] = [];

  parts.push(`## Your Task\n\n${ctx.objective}`);

  if (ctx.sharedContext) {
    parts.push(`## Overall Goal\n\nThe user's original request:\n${ctx.sharedContext}`);
  }

  if (ctx.dependencyResults.length > 0) {
    const depSection = ctx.dependencyResults
      .map((d) => `### ${d.taskName}\n\n${d.result}`)
      .join('\n\n');
    parts.push(`## Results from Previous Tasks\n\n${depSection}`);
  }

  parts.push(
    '## Instructions\n\n' +
      '- Focus ONLY on your assigned task\n' +
      '- Use the tools available to you to complete the task\n' +
      '- Return a clear, structured result that can be used by other tasks\n' +
      '- Do NOT attempt tasks outside your scope',
  );

  return parts.join('\n\n');
}

/**
 * 截断过长的结果文本，保留关键信息。
 */
function truncateResult(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  // 保留开头和结尾
  const headLength = Math.floor(maxLength * 0.7);
  const tailLength = maxLength - headLength - 30;
  return (
    text.slice(0, headLength) +
    '\n\n[... truncated ...]\n\n' +
    text.slice(-tailLength)
  );
}
