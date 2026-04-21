// ─── Modification Lock ──────────────────────────────────────────────────────
// 文件锁 + 修改队列，防止多个修改请求并发冲突

import {
  writeFileSync,
  existsSync,
  unlinkSync,
  readFileSync,
} from 'fs';
import { createDebug } from '../utils/debug.js';
import type { CodeChangeRequest, ModificationResult } from './types.js';

const log = createDebug('self-iteration:lock');

/** 锁超时时间：10 分钟 */
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

interface LockInfo {
  operator: string;
  timestamp: number;
  pid: number;
  requestId: string;
}

/**
 * 文件级排他锁，防止并发修改
 * 副作用：创建/删除 .self-iteration.lock 文件
 */
export class ModificationLock {
  private lockFile: string;

  constructor(workDir: string) {
    this.lockFile = `${workDir}/.self-iteration.lock`;
  }

  /**
   * 尝试获取锁
   * 如果锁被持有且未超时，返回持有者信息
   */
  acquire(operator: string, requestId: string): {
    acquired: boolean;
    heldBy?: string;
    heldSince?: number;
  } {
    if (existsSync(this.lockFile)) {
      try {
        const info: LockInfo = JSON.parse(
          readFileSync(this.lockFile, 'utf-8'),
        );
        // 防止死锁：超时的锁自动释放
        if (Date.now() - info.timestamp < LOCK_TIMEOUT_MS) {
          log.warn(
            `锁被 ${info.operator} 持有 (request: ${info.requestId})`,
          );
          return {
            acquired: false,
            heldBy: info.operator,
            heldSince: info.timestamp,
          };
        }
        log.warn(`锁已超时 (${info.operator})，强制释放`);
      } catch {
        // 锁文件损坏，忽略并重新获取
        log.warn('锁文件损坏，重新获取');
      }
    }

    const lockInfo: LockInfo = {
      operator,
      timestamp: Date.now(),
      pid: globalThis.process?.pid ?? 0,
      requestId,
    };

    writeFileSync(this.lockFile, JSON.stringify(lockInfo, null, 2));
    log.info(`锁已获取: ${operator} (request: ${requestId})`);
    return { acquired: true };
  }

  /**
   * 释放锁
   */
  release(): void {
    if (existsSync(this.lockFile)) {
      unlinkSync(this.lockFile);
      log.info('锁已释放');
    }
  }

  /**
   * 检查是否被锁定
   */
  isLocked(): boolean {
    if (!existsSync(this.lockFile)) return false;
    try {
      const info: LockInfo = JSON.parse(
        readFileSync(this.lockFile, 'utf-8'),
      );
      return Date.now() - info.timestamp < LOCK_TIMEOUT_MS;
    } catch {
      return false;
    }
  }
}

// ─── Modification Queue ─────────────────────────────────────────────────────

type QueueHandler = (
  request: CodeChangeRequest,
) => Promise<ModificationResult>;

interface QueueItem {
  request: CodeChangeRequest;
  resolve: (result: ModificationResult) => void;
  reject: (error: Error) => void;
}

/**
 * 修改请求队列：串行化所有修改，避免并发冲突
 */
export class ModificationQueue {
  private queue: QueueItem[] = [];
  private processing = false;
  private handler: QueueHandler;

  constructor(handler: QueueHandler) {
    this.handler = handler;
  }

  /**
   * 将修改请求加入队列，返回 Promise 等待结果
   */
  async enqueue(request: CodeChangeRequest): Promise<ModificationResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      log.info(
        `请求入队: ${request.description} (队列长度: ${this.queue.length})`,
      );
      if (!this.processing) {
        this.processNext();
      }
    });
  }

  /**
   * 当前队列长度
   */
  get length(): number {
    return this.queue.length;
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    const item = this.queue.shift();
    if (!item) {
      this.processing = false;
      return;
    }

    try {
      log.info(`开始处理: ${item.request.description}`);
      const result = await this.handler(item.request);
      item.resolve(result);
    } catch (err) {
      item.reject(err as Error);
    }

    // 处理下一个（用 setImmediate 避免阻塞事件循环）
    setImmediate(() => this.processNext());
  }
}
