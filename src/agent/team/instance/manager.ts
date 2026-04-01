import type { InstanceStatus, ResourceLimits } from '../types.js';
import { createDebug } from '../../../utils/debug.js';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const debug = createDebug('agent:team:instance');

/**
 * Agent 实例接口
 */
export interface AgentInstance {
  /** 实例 ID */
  id: string;

  /** 实例类型 */
  type: string;

  /** 运行上下文 */
  context: {
    memory: any;
    workspace: string;
    tools: any[];
  };

  /** 实例状态 */
  status: InstanceStatus;

  /** 最后使用时间 */
  lastUsed: Date;
}

/**
 * 实例管理器配置
 */
export interface InstanceManagerConfig {
  /** 工作目录 */
  workDir: string;

  /** 资源限制 */
  resourceLimits: ResourceLimits;
}

/**
 * Agent 实例管理器
 */
export class AgentInstanceManager {
  private instances: Map<string, AgentInstance> = new Map();
  private taskAssignments: Map<string, string> = new Map();
  private config: InstanceManagerConfig;

  constructor(config: InstanceManagerConfig) {
    this.config = config;
  }

  /**
   * 创建新的 Agent 实例
   */
  async createInstance(type: string): Promise<AgentInstance> {
    await this.checkResources();

    const id = `${type}-${randomUUID()}`;
    const workspace = await this.createWorkspace(id);

    const instance: AgentInstance = {
      id,
      type,
      context: {
        memory: {},
        workspace,
        tools: [],
      },
      status: 'idle',
      lastUsed: new Date(),
    };

    this.instances.set(id, instance);
    debug.info('Created instance: %O', instance);

    return instance;
  }

  /**
   * 获取可用的 Agent 实例
   */
  async getInstance(type: string): Promise<AgentInstance> {
    debug.info('Getting instance for type: %s', type);

    const idle = Array.from(this.instances.values()).find(
      (i) => i.type === type && i.status === 'idle',
    );

    if (idle) {
      debug.info('Found idle instance: %s', idle.id);
      return idle;
    }

    return this.createInstance(type);
  }

  /**
   * 释放实例资源
   */
  async releaseInstance(instanceId: string): Promise<void> {
    debug.info('Releasing instance: %s', instanceId);

    const instance = this.instances.get(instanceId);
    if (!instance) {
      debug.warn('Instance not found: %s', instanceId);
      return;
    }

    await this.cleanWorkspace(instance.context.workspace);

    instance.status = 'idle';
    instance.context.memory = {};
    instance.lastUsed = new Date();

    debug.info('Released instance: %s', instanceId);
  }

  /**
   * 销毁实例
   */
  async destroyInstance(instanceId: string): Promise<void> {
    debug.info('Destroying instance: %s', instanceId);

    const instance = this.instances.get(instanceId);
    if (!instance) {
      debug.warn('Instance not found: %s', instanceId);
      return;
    }

    await this.cleanWorkspace(instance.context.workspace);
    this.instances.delete(instanceId);

    debug.info('Destroyed instance: %s', instanceId);
  }

  /**
   * 检查资源限制
   */
  private async checkResources(): Promise<void> {
    const { resourceLimits } = this.config;

    if (this.instances.size >= resourceLimits.maxInstances) {
      throw new Error('Maximum instance limit reached');
    }

    const totalMemory = process.memoryUsage().heapUsed;
    if (totalMemory >= resourceLimits.maxTotalMemory) {
      throw new Error('Maximum memory limit reached');
    }

    const activeTasks = Array.from(this.instances.values()).filter(
      (i) => i.status === 'busy',
    ).length;
    if (activeTasks >= resourceLimits.maxConcurrentTasks) {
      throw new Error('Maximum concurrent task limit reached');
    }
  }

  /**
   * 创建实例工作空间
   */
  private async createWorkspace(instanceId: string): Promise<string> {
    const workspacePath = path.join(this.config.workDir, instanceId);
    await fs.mkdir(workspacePath, { recursive: true });
    return workspacePath;
  }

  /**
   * 清理工作空间
   */
  private async cleanWorkspace(workspace: string): Promise<void> {
    try {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.mkdir(workspace, { recursive: true });
    } catch (error) {
      debug.error('Failed to clean workspace: %O', error);
    }
  }
}
