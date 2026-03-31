/**
 * Cron Scheduler - node-cron 调度器
 */

import type { CronTask, CronEvent } from './types.js';
import type { CronExecutor } from './executor.js';
import type { CronStore } from './store.js';
import { createDebug } from '../utils/debug.js';
import cron, { type ScheduledTask } from 'node-cron';
import cron_parser from 'cron-parser';

const log = createDebug('cron:scheduler');

export class CronScheduler {
  private readonly store: CronStore;
  private readonly executor: CronExecutor;
  private readonly scheduledTasks: Map<string, ScheduledTask> = new Map();
  private eventHandlers: Array<(event: CronEvent) => void> = [];
  private running = false;

  constructor(store: CronStore, executor: CronExecutor) {
    this.store = store;
    this.executor = executor;
  }

  /**
   * 启动调度器
   */
  async start(): Promise<void> {
    if (this.running) {
      log.warn('Scheduler already running');
      return;
    }

    this.running = true;
    log.info('Cron scheduler started');

    await this.store.initialize();

    const tasks = await this.store.listEnabled();
    for (const task of tasks) {
      await this.scheduleTask(task);
    }

    log.info(`Scheduled ${tasks.length} cron tasks`);

    this.store.onEvent((event) => {
      this.handleStoreEvent(event);
    });
  }

  /**
   * 停止调度器
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    for (const [, task] of this.scheduledTasks) {
      task.stop();
      log.debug(`Stopped task`);
    }

    this.scheduledTasks.clear();
    log.info('Cron scheduler stopped');
  }

  /**
   * 处理 store 事件
   */
  private async handleStoreEvent(event: CronEvent): Promise<void> {
    switch (event.type) {
      case 'task:created':
        await this.onTaskCreated(event.taskId);
        break;
      case 'task:updated':
        await this.onTaskUpdated(event.taskId);
        break;
      case 'task:deleted':
        this.onTaskDeleted(event.taskId);
        break;
    }
  }

  /**
   * 任务创建事件处理
   */
  private async onTaskCreated(taskId: string): Promise<void> {
    const task = await this.store.get(taskId);
    if (!task) return;

    if (task.enabled) {
      await this.scheduleTask(task);
    }
  }

  /**
   * 任务更新事件处理
   */
  private async onTaskUpdated(taskId: string): Promise<void> {
    this.unscheduleTask(taskId);

    const task = await this.store.get(taskId);
    if (!task) return;

    if (task.enabled) {
      await this.scheduleTask(task);
    }
  }

  /**
   * 任务删除事件处理
   */
  private onTaskDeleted(taskId: string): void {
    this.unscheduleTask(taskId);
  }

  /**
   * 调度单个任务
   */
  private async scheduleTask(task: CronTask): Promise<void> {
    if (!this.running) return;

    if (this.scheduledTasks.has(task.id)) {
      this.unscheduleTask(task.id);
    }

    if (!cron.validate(task.cronExpression)) {
      log.error(
        `Invalid cron expression for task ${task.name}: ${task.cronExpression}`,
      );
      return;
    }

    const scheduledTask = cron.schedule(
      task.cronExpression,
      async () => {
        if (!this.running) return;

        if (!this.store.verifyTaskSignature(task)) {
          log.error(
            `Task ${task.id} signature verification failed, skipping execution`,
          );
          return;
        }

        const context = task.notificationTarget
          ? {
              channel: 'feishu' as const,
              userId: 'cron-system',
              sessionId: `cron-${task.id}`,
              metadata: {
                chatId: task.notificationTarget.chatId,
                receiveIdType:
                  task.notificationTarget.receiveIdType || 'chat_id',
              },
            }
          : undefined;

        const result = await this.executor.execute(task, context);

        if (task.runOnce) {
          log.info(`One-time task ${task.name} completed, removing...`);
          await this.store.delete(task.id);
          return;
        }

        const nextRunAt = this.calculateNextRunTime(task.cronExpression);

        await this.store.updateRunStatus(
          task.id,
          result.executedAt,
          nextRunAt,
          result.result,
          result.error,
        );

        this.emit({
          type: 'task:run',
          taskId: task.id,
          data: result,
          timestamp: Date.now(),
        });
      },
      {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    );

    this.scheduledTasks.set(task.id, scheduledTask);

    const nextRunAt = this.calculateNextRunTime(task.cronExpression);
    await this.store.updateRunStatus(task.id, task.lastRunAt || 0, nextRunAt);

    log.info(
      `Scheduled task: ${task.name} (next run: ${new Date(nextRunAt).toISOString()})`,
    );
  }

  /**
   * 计算 cron 表达式下一次运行时间
   */
  private calculateNextRunTime(cronExpression: string): number {
    try {
      const expr = cron_parser.CronExpressionParser.parse(cronExpression);
      return expr.next().getTime();
    } catch (error) {
      log.warn(`Invalid cron expression: ${cronExpression}`);
      return Date.now() + 60 * 60 * 1000;
    }
  }

  /**
   * 取消调度任务
   */
  private unscheduleTask(taskId: string): void {
    const task = this.scheduledTasks.get(taskId);
    if (task) {
      task.stop();
      this.scheduledTasks.delete(taskId);
      log.debug(`Unscheduled task: ${taskId}`);
    }
  }

  /**
   * 注册事件处理器
   */
  onEvent(handler: (event: CronEvent) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const index = this.eventHandlers.indexOf(handler);
      if (index !== -1) {
        this.eventHandlers.splice(index, 1);
      }
    };
  }

  /**
   * 触发事件
   */
  private emit(event: CronEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        log.warn(`Event handler error: ${error}`);
      }
    }
  }

  /**
   * 获取调度状态
   */
  getStatus(): {
    running: boolean;
    scheduledTasks: number;
  } {
    return {
      running: this.running,
      scheduledTasks: this.scheduledTasks.size,
    };
  }

  /**
   * 手动触发一个任务（立即执行）
   */
  async runTaskNow(taskId: string): Promise<void> {
    const task = await this.store.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const context = task.notificationTarget
      ? {
          channel: 'feishu' as const,
          userId: 'cron-system',
          sessionId: `cron-${task.id}`,
          metadata: {
            chatId: task.notificationTarget.chatId,
            receiveIdType:
              task.notificationTarget.receiveIdType || 'chat_id',
          },
        }
      : undefined;

    const result = await this.executor.execute(task, context);

    if (task.runOnce) {
      log.info(`One-time task ${task.name} completed, removing...`);
      await this.store.delete(task.id);
      return;
    }

    const nextRunAt = this.calculateNextRunTime(task.cronExpression);

    await this.store.updateRunStatus(
      task.id,
      result.executedAt,
      nextRunAt,
      result.result,
      result.error,
    );

    this.emit({
      type: 'task:run',
      taskId: task.id,
      data: result,
      timestamp: Date.now(),
    });
  }
}

let globalScheduler: CronScheduler | null = null;

export function getCronScheduler(
  store: CronStore,
  executor: CronExecutor,
): CronScheduler {
  if (!globalScheduler) {
    globalScheduler = new CronScheduler(store, executor);
  }
  return globalScheduler;
}

export function resetCronScheduler(): void {
  if (globalScheduler) {
    globalScheduler.stop();
  }
  globalScheduler = null;
}
