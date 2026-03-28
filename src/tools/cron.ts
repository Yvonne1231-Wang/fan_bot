/**
 * Cron Tools - cron_create, cron_list, cron_delete
 */

import type { Tool } from './types.js';
import type { CronStore } from '../cron/store.js';
import type { CronScheduler } from '../cron/scheduler.js';
import type {
  CronTaskType,
  AgentTaskPayload,
  NotificationTaskPayload,
  ShellTaskPayload,
} from '../cron/types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('tools:cron');

let globalStore: CronStore | null = null;
let globalScheduler: CronScheduler | null = null;

export function setCronDeps(store: CronStore, scheduler: CronScheduler): void {
  globalStore = store;
  globalScheduler = scheduler;
}

function getStore(): CronStore {
  if (!globalStore) {
    throw new Error('Cron store not initialized');
  }
  return globalStore;
}

function getScheduler(): CronScheduler {
  if (!globalScheduler) {
    throw new Error('Cron scheduler not initialized');
  }
  return globalScheduler;
}

function validateCronExpression(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) {
    return false;
  }
  const cronRegex = /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/[0-9]+|[0-9]+-[0-9]+|[0-9]+,[0-9]+)+$/;
  return parts.every((part) => cronRegex.test(part));
}

function formatTaskList(tasks: Awaited<ReturnType<CronStore['list']>>): string {
  if (tasks.length === 0) {
    return 'No cron tasks found.';
  }

  const lines = tasks.map((task) => {
    const status = task.enabled ? '✅' : '❌';
    const lastRun = task.lastRunAt
      ? new Date(task.lastRunAt).toLocaleString()
      : 'Never';
    const nextRun = task.nextRunAt
      ? new Date(task.nextRunAt).toLocaleString()
      : 'N/A';
    const lastResult = task.lastError
      ? `\n   Last error: ${task.lastError.slice(0, 100)}...`
      : task.lastResult
        ? `\n   Last result: ${task.lastResult.slice(0, 100)}...`
        : '';

    return [
      `${status} ${task.name} (${task.id})`,
      `   Type: ${task.type} | Schedule: ${task.cronExpression}`,
      `   Last run: ${lastRun} | Next run: ${nextRun}`,
      `${lastResult}`,
    ].join('\n');
  });

  return lines.join('\n\n');
}

/**
 * Cron Create Tool
 *
 * Create a new cron task with specified schedule and action.
 */
export const cronCreateTool: Tool = {
  schema: {
    name: 'cron_create',
    description:
      'Create a new cron task. Supported types: agent (run prompt through AI agent), notification (send a message), shell (execute a shell command).',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name/description of the cron task',
        },
        type: {
          type: 'string',
          enum: ['agent', 'notification', 'shell'],
          description: 'Type of task to execute',
        },
        cron_expression: {
          type: 'string',
          description:
            'Cron expression (e.g., "0 8 * * *" for daily at 8am, "*/30 * * * *" for every 30 minutes)',
        },
        prompt: {
          type: 'string',
          description:
            'Prompt for agent type task - what should the agent do? (required for type=agent)',
        },
        message: {
          type: 'string',
          description:
            'Message for notification type task (required for type=notification)',
        },
        command: {
          type: 'string',
          description:
            'Shell command to execute (required for type=shell)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds for shell commands (default: 60000)',
        },
      },
      required: ['name', 'type', 'cron_expression'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const name = String(input.name);
    const type = input.type as CronTaskType;
    const cronExpression = String(input.cron_expression);

    if (!validateCronExpression(cronExpression)) {
      throw new Error(
        `Invalid cron expression: ${cronExpression}. Expected 5 fields: minute hour day month weekday`,
      );
    }

    let payload: AgentTaskPayload | NotificationTaskPayload | ShellTaskPayload;

    switch (type) {
      case 'agent':
        if (!input.prompt) {
          throw new Error('prompt is required for agent type task');
        }
        payload = { prompt: String(input.prompt) };
        break;
      case 'notification':
        if (!input.message) {
          throw new Error('message is required for notification type task');
        }
        payload = { message: String(input.message) };
        break;
      case 'shell':
        if (!input.command) {
          throw new Error('command is required for shell type task');
        }
        payload = {
          command: String(input.command),
          timeout: input.timeout ? Number(input.timeout) : 60000,
        };
        break;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }

    const store = getStore();
    const task = await store.create({
      name,
      type,
      cronExpression,
      payload,
      enabled: true,
    });

    log.info(`Created cron task: ${task.name} (${task.id})`);

    return `Cron task created successfully:
- ID: ${task.id}
- Name: ${task.name}
- Type: ${task.type}
- Schedule: ${task.cronExpression}
- Status: ${task.enabled ? 'Enabled' : 'Disabled'}`;
  },

  riskLevel: 'medium',
  requiresConfirmation: false,
};

/**
 * Cron List Tool
 *
 * List all cron tasks or get details of a specific task.
 */
export const cronListTool: Tool = {
  schema: {
    name: 'cron_list',
    description:
      'List all cron tasks or get details of a specific task by ID',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Optional task ID to get specific task details',
        },
        enabled_only: {
          type: 'boolean',
          description: 'Only list enabled tasks (default: false)',
        },
      },
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const store = getStore();
    const taskId = input.task_id as string | undefined;
    const enabledOnly = (input.enabled_only as boolean) || false;

    if (taskId) {
      const task = await store.get(taskId);
      if (!task) {
        return `Task not found: ${taskId}`;
      }

      return [
        `Task: ${task.name} (${task.id})`,
        `Type: ${task.type}`,
        `Schedule: ${task.cronExpression}`,
        `Status: ${task.enabled ? 'Enabled' : 'Disabled'}`,
        `Created: ${new Date(task.createdAt).toLocaleString()}`,
        `Last run: ${task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : 'Never'}`,
        `Next run: ${task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : 'N/A'}`,
        `Last result: ${task.lastResult || 'N/A'}`,
        task.lastError ? `Last error: ${task.lastError}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    const tasks = enabledOnly ? await store.listEnabled() : await store.list();
    return formatTaskList(tasks);
  },

  riskLevel: 'low',
  requiresConfirmation: false,
};

/**
 * Cron Delete Tool
 *
 * Delete a cron task by ID.
 */
export const cronDeleteTool: Tool = {
  schema: {
    name: 'cron_delete',
    description: 'Delete a cron task by its ID',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to delete',
        },
      },
      required: ['task_id'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const taskId = String(input.task_id);

    const store = getStore();
    const deleted = await store.delete(taskId);

    if (!deleted) {
      return `Task not found: ${taskId}`;
    }

    log.info(`Deleted cron task: ${taskId}`);
    return `Task deleted successfully: ${taskId}`;
  },

  riskLevel: 'high',
  requiresConfirmation: true,
};

/**
 * Cron Toggle Tool
 *
 * Enable or disable a cron task.
 */
export const cronToggleTool: Tool = {
  schema: {
    name: 'cron_toggle',
    description: 'Enable or disable a cron task by its ID',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to toggle',
        },
      },
      required: ['task_id'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const taskId = String(input.task_id);

    const store = getStore();
    const task = await store.toggle(taskId);

    if (!task) {
      return `Task not found: ${taskId}`;
    }

    log.info(`Toggled cron task: ${taskId} -> ${task.enabled}`);
    return `Task ${task.name} is now ${task.enabled ? 'enabled' : 'disabled'}`;
  },

  riskLevel: 'medium',
  requiresConfirmation: false,
};

/**
 * Cron Run Now Tool
 *
 * Manually trigger a cron task to run immediately.
 */
export const cronRunNowTool: Tool = {
  schema: {
    name: 'cron_run_now',
    description: 'Manually trigger a cron task to run immediately',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to run',
        },
      },
      required: ['task_id'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const taskId = String(input.task_id);

    const scheduler = getScheduler();

    try {
      await scheduler.runTaskNow(taskId);
      log.info(`Manually ran cron task: ${taskId}`);
      return `Task triggered successfully: ${taskId}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to run task: ${message}`;
    }
  },

  riskLevel: 'medium',
  requiresConfirmation: false,
};
