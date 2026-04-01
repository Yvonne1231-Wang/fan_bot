import type { AgentInstanceManager } from './manager.js';
import { createDebug } from '../../../utils/debug.js';

const debug = createDebug('agent:team:instance:lifecycle');

/**
 * Agent 实例生命周期管理器
 */
export class AgentLifecycleManager {
  private readonly MAX_IDLE_TIME = 30 * 60 * 1000;
  private readonly CHECK_INTERVAL = 5 * 60 * 1000;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private instanceManager: AgentInstanceManager) {
    this.startCleanupTimer();
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer() {
    debug.info('Starting cleanup timer');
    this.cleanupTimer = setInterval(() => this.cleanup(), this.CHECK_INTERVAL);
  }

  /**
   * 停止清理定时器
   */
  stopCleanupTimer() {
    debug.info('Stopping cleanup timer');
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 清理闲置实例
   */
  private async cleanup() {
    debug.info('Running instance cleanup');
    const now = new Date();

    const instances = (this.instanceManager as any).instances as Map<
      string,
      { status: string; lastUsed: Date }
    >;

    for (const [id, instance] of instances) {
      if (instance.status === 'idle') {
        const idleTime = now.getTime() - instance.lastUsed.getTime();

        if (idleTime > this.MAX_IDLE_TIME) {
          debug.info(
            'Destroying idle instance: %s (idle for %d ms)',
            id,
            idleTime,
          );
          await this.instanceManager.destroyInstance(id);
        }
      }
    }
  }

  /**
   * 资源回收
   */
  async dispose(): Promise<void> {
    debug.info('Disposing lifecycle manager');

    this.stopCleanupTimer();

    const instances = (this.instanceManager as any).instances as Map<
      string,
      unknown
    >;
    const destroyPromises = Array.from(instances.keys()).map((id) =>
      this.instanceManager.destroyInstance(id),
    );

    await Promise.all(destroyPromises);
  }
}
