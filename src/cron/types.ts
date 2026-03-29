/**
 * Cron Task Types
 */

export type CronTaskType = 'agent' | 'notification' | 'shell';

export interface AgentTaskPayload {
  prompt: string;
}

export interface NotificationTaskPayload {
  message: string;
}

export interface ShellTaskPayload {
  command: string;
  timeout?: number;
}

export type CronTaskPayload =
  | AgentTaskPayload
  | NotificationTaskPayload
  | ShellTaskPayload;

export interface CronTask {
  id: string;
  name: string;
  type: CronTaskType;
  cronExpression: string;
  payload: CronTaskPayload;
  enabled: boolean;
  runOnce?: boolean;
  notificationTarget?: {
    chatId: string;
    receiveIdType?: 'chat_id' | 'open_id';
  };
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  lastResult?: string;
  lastError?: string;
  signature?: string;
  createdBy?: string;
}

export interface CreateCronTaskInput {
  name: string;
  type: CronTaskType;
  cronExpression: string;
  payload: CronTaskPayload;
  enabled?: boolean;
  runOnce?: boolean;
  notificationTarget?: {
    chatId: string;
    receiveIdType?: 'chat_id' | 'open_id';
  };
}

export interface CronExecutionResult {
  taskId: string;
  success: boolean;
  result?: string;
  error?: string;
  executedAt: number;
}

export interface CronExecutorInterface {
  execute(task: CronTask): Promise<CronExecutionResult>;
}

export type CronEventType =
  | 'task:run'
  | 'task:created'
  | 'task:updated'
  | 'task:deleted';

export interface CronEvent {
  type: CronEventType;
  taskId: string;
  data?: unknown;
  timestamp: number;
}

export type CronEventHandler = (event: CronEvent) => void;
