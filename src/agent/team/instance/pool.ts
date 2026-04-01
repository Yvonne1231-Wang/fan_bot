import type { AgentInstance } from './manager.js';
import { createDebug } from '../../../utils/debug.js';

const debug = createDebug('agent:team:instance:pool');

/**
 * Agent 实例池
 * 用于缓存和复用 Agent 实例
 */
export class AgentInstancePool {
  private pools: Map<string, AgentInstance[]> = new Map();
  private maxInstancesPerType: number;

  constructor(maxInstancesPerType: number = 5) {
    this.maxInstancesPerType = maxInstancesPerType;
  }

  /**
   * 借用实例
   */
  async borrowInstance(type: string): Promise<AgentInstance | null> {
    debug.info('Borrowing instance of type: %s', type);

    const pool = this.pools.get(type) || [];

    const idleInstance = pool.find((i) => i.status === 'idle');
    if (idleInstance) {
      debug.info('Found idle instance: %s', idleInstance.id);
      return idleInstance;
    }

    debug.info('No idle instance found for type: %s', type);
    return null;
  }

  /**
   * 归还实例
   */
  async returnInstance(instance: AgentInstance): Promise<void> {
    debug.info('Returning instance: %s', instance.id);

    const pool = this.pools.get(instance.type) || [];

    if (pool.length >= this.maxInstancesPerType) {
      debug.info(
        'Pool is full for type: %s, removing oldest instance',
        instance.type,
      );
      pool.shift();
    }

    instance.status = 'idle';
    instance.lastUsed = new Date();

    pool.push(instance);
    this.pools.set(instance.type, pool);

    debug.info('Instance returned successfully');
  }

  /**
   * 清理实例池
   */
  async clear(): Promise<void> {
    debug.info('Clearing instance pool');
    this.pools.clear();
  }

  /**
   * 获取实例池状态
   */
  getStatus(): Record<string, number> {
    const status: Record<string, number> = {};

    for (const [type, pool] of this.pools) {
      status[type] = pool.length;
    }

    return status;
  }
}
