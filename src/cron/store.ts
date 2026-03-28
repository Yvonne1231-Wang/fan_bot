/**
 * Cron Task Store - JSON File Persistence
 */

import { mkdir, readFile, writeFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import type {
  CronTask,
  CreateCronTaskInput,
  CronEventHandler,
  CronEvent,
} from './types.js';
import { createDebug } from '../utils/debug.js';
import {
  computeSignature,
  verifySignature,
  SecurityError,
} from './security.js';

const log = createDebug('cron:store');

const CRON_DIR = '.fan_bot';
const CRON_FILE = 'cron-tasks.json';

export interface CronStoreOptions {
  dir?: string;
}

export class CronStore {
  private readonly filePath: string;
  private tasks: Map<string, CronTask> = new Map();
  private eventHandlers: Set<CronEventHandler> = new Set();
  private initialized = false;

  constructor(options: CronStoreOptions = {}) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
    const baseDir = options.dir || join(homeDir, CRON_DIR);
    this.filePath = join(baseDir, CRON_FILE);
  }

  /**
   * Ensure store directory exists
   */
  private async ensureDir(): Promise<void> {
    try {
      await access(dirname(this.filePath));
    } catch {
      await mkdir(dirname(this.filePath), { recursive: true });
    }
  }

  /**
   * Load tasks from disk
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.ensureDir();

    try {
      const content = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content) as CronTask[];
      this.tasks.clear();
      for (const task of data) {
        this.tasks.set(task.id, task);
      }
      log.info(`Loaded ${this.tasks.size} cron tasks`);
    } catch (error) {
      const err = error as { code?: string };
      if (err.code !== 'ENOENT') {
        log.warn(`Failed to load cron tasks: ${error}`);
      }
      this.tasks.clear();
    }

    this.initialized = true;
  }

  /**
   * Persist tasks to disk
   */
  private async persist(): Promise<void> {
    await this.ensureDir();
    const data = Array.from(this.tasks.values());
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Generate unique task ID
   */
  private generateId(): string {
    return `cron_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Verify task signature to prevent tampering
   */
  verifyTaskSignature(task: CronTask): boolean {
    if (!task.signature) {
      log.debug(`Task ${task.id} has no signature, skipping verification`);
      return true;
    }

    const taskData = JSON.stringify({
      name: task.name,
      type: task.type,
      cronExpression: task.cronExpression,
      payload: task.payload,
    });

    const isValid = verifySignature(taskData, task.signature);

    if (!isValid) {
      log.warn(`Task ${task.id} signature verification failed`);
    }

    return isValid;
  }

  /**
   * Emit event to all handlers
   */
  private emit(type: CronEvent['type'], taskId: string, data?: unknown): void {
    const event: CronEvent = {
      type,
      taskId,
      data,
      timestamp: Date.now(),
    };
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        log.warn(`Event handler error: ${error}`);
      }
    }
  }

  /**
   * Create a new cron task
   */
  async create(
    input: CreateCronTaskInput,
    createdBy?: string,
  ): Promise<CronTask> {
    const now = Date.now();
    const taskData = JSON.stringify({
      name: input.name,
      type: input.type,
      cronExpression: input.cronExpression,
      payload: input.payload,
    });
    const signature = computeSignature(taskData);

    const task: CronTask = {
      id: this.generateId(),
      name: input.name,
      type: input.type,
      cronExpression: input.cronExpression,
      payload: input.payload,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      signature,
      createdBy,
    };

    this.tasks.set(task.id, task);
    await this.persist();
    this.emit('task:created', task.id, task);

    log.info(`Created cron task: ${task.name} (${task.id})`);
    return task;
  }

  /**
   * Get a task by ID
   */
  async get(id: string): Promise<CronTask | null> {
    return this.tasks.get(id) || null;
  }

  /**
   * Get all tasks
   */
  async list(): Promise<CronTask[]> {
    return Array.from(this.tasks.values());
  }

  /**
   * Get all enabled tasks
   */
  async listEnabled(): Promise<CronTask[]> {
    return Array.from(this.tasks.values()).filter((t) => t.enabled);
  }

  /**
   * Update a task
   */
  async update(
    id: string,
    updates: Partial<Omit<CronTask, 'id' | 'createdAt'>>,
  ): Promise<CronTask | null> {
    const task = this.tasks.get(id);
    if (!task) return null;

    const updated: CronTask = {
      ...task,
      ...updates,
      updatedAt: Date.now(),
    };

    this.tasks.set(id, updated);
    await this.persist();
    this.emit('task:updated', id, updated);

    log.info(`Updated cron task: ${updated.name} (${id})`);
    return updated;
  }

  /**
   * Delete a task
   */
  async delete(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task) return false;

    this.tasks.delete(id);
    await this.persist();
    this.emit('task:deleted', id);

    log.info(`Deleted cron task: ${task.name} (${id})`);
    return true;
  }

  /**
   * Update task execution status
   */
  async updateRunStatus(
    id: string,
    lastRunAt: number,
    nextRunAt: number,
    result?: string,
    error?: string,
  ): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;

    task.lastRunAt = lastRunAt;
    task.nextRunAt = nextRunAt;
    task.lastResult = result;
    task.lastError = error;
    task.updatedAt = Date.now();

    await this.persist();
  }

  /**
   * Toggle task enabled status
   */
  async toggle(id: string): Promise<CronTask | null> {
    const task = this.tasks.get(id);
    if (!task) return null;

    task.enabled = !task.enabled;
    task.updatedAt = Date.now();

    await this.persist();
    this.emit('task:updated', id, task);

    return task;
  }

  /**
   * Register event handler
   */
  onEvent(handler: CronEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Get task count
   */
  get size(): number {
    return this.tasks.size;
  }
}

let globalStore: CronStore | null = null;

export function getCronStore(options?: CronStoreOptions): CronStore {
  if (!globalStore) {
    globalStore = new CronStore(options);
  }
  return globalStore;
}
