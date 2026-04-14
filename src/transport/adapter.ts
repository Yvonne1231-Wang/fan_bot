// ─── Channel Adapter ───────────────────────────────────────────────────────

import type {
  UnifiedMessage,
  UnifiedResponse,
  StreamEvent,
  ChannelType,
  MessageContext,
} from './unified.js';
import type { AgentCallbacks } from '../llm/types.js';
import { getErrorMessage } from '../utils/error.js';

/**
 * 渠道适配器配置
 */
export interface ChannelAdapterConfig {
  /** 渠道类型 */
  channelType: ChannelType;

  /** 是否启用流式响应 */
  enableStream?: boolean;

  /** 响应超时时间（毫秒） */
  timeout?: number;

  /** 重试次数 */
  maxRetries?: number;
}

/**
 * 消息处理器函数类型
 *
 * 所有渠道的消息最终都会通过这个处理器交给 Agent 处理
 */
export type MessageHandler = (
  message: UnifiedMessage,
  callbacks?: AgentCallbacks,
) => Promise<UnifiedResponse>;

/**
 * 流式消息处理器函数类型
 */
export type StreamMessageHandler = (
  message: UnifiedMessage,
  onEvent: (event: StreamEvent) => void,
) => Promise<void>;

/**
 * 渠道适配器接口
 *
 * 定义了所有渠道必须实现的方法，用于统一消息的收发。
 * 每个渠道（CLI、HTTP、飞书等）都需要实现这个接口。
 */
export interface ChannelAdapter {
  /** 渠道类型 */
  readonly channelType: ChannelType;

  /** 渠道名称（用于日志和调试） */
  readonly name: string;

  /**
   * 初始化适配器
   *
   * 在启动时调用，用于建立连接、注册事件监听等
   */
  initialize(): Promise<void>;

  /**
   * 设置消息处理器
   *
   * 当收到消息时，适配器会调用这个处理器
   *
   * @param handler - 消息处理函数
   */
  setMessageHandler(handler: MessageHandler): void;

  /**
   * 设置流式消息处理器
   *
   * 用于支持流式响应的场景
   *
   * @param handler - 流式消息处理函数
   */
  setStreamHandler?(handler: StreamMessageHandler): void;

  /**
   * 发送响应
   *
   * 将统一响应转换为渠道特定格式并发送
   *
   * @param response - 统一响应
   * @param context - 消息上下文
   */
  send(response: UnifiedResponse, context: MessageContext): Promise<void>;

  /**
   * 发送流式响应
   *
   * 用于实时更新响应内容
   *
   * @param event - 流式事件
   * @param context - 消息上下文
   */
  sendStream?(event: StreamEvent, context: MessageContext): Promise<void>;

  /**
   * 关闭适配器
   *
   * 清理资源、断开连接等
   */
  close(): Promise<void>;

  /**
   * 健康检查
   *
   * 返回适配器的健康状态
   */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}

/**
 * 渠道适配器基类
 *
 * 提供通用的初始化、消息处理器管理等基础功能
 */
export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract readonly channelType: ChannelType;
  abstract readonly name: string;

  protected config: ChannelAdapterConfig;
  protected messageHandler: MessageHandler | null = null;
  protected streamHandler: StreamMessageHandler | null = null;
  protected initialized = false;

  constructor(config: ChannelAdapterConfig) {
    this.config = {
      enableStream: false,
      timeout: 30000,
      maxRetries: 3,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.doInitialize();
    this.initialized = true;
  }

  /**
   * 子类实现的具体初始化逻辑
   */
  protected abstract doInitialize(): Promise<void>;

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  setStreamHandler(handler: StreamMessageHandler): void {
    this.streamHandler = handler;
  }

  abstract send(
    response: UnifiedResponse,
    context: MessageContext,
  ): Promise<void>;

  async close(): Promise<void> {
    this.messageHandler = null;
    this.streamHandler = null;
    this.initialized = false;
    await this.doClose();
  }

  /**
   * 子类实现的具体关闭逻辑
   */
  protected async doClose(): Promise<void> {
    // 默认空实现，子类可覆盖
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return {
      healthy: this.initialized,
      message: this.initialized
        ? `${this.name} is running`
        : `${this.name} not initialized`,
    };
  }

  /**
   * 处理消息的通用入口
   *
   * 子类在收到消息时应调用此方法
   */
  protected async handleMessage(message: UnifiedMessage): Promise<void> {
    if (!this.messageHandler) {
      throw new Error(`No message handler set for ${this.name}`);
    }

    try {
      const response = await this.messageHandler(message);
      await this.send(response, message.context);
    } catch (error) {
      const errorMessage =
        getErrorMessage(error);
      await this.sendError(message.context, errorMessage);
    }
  }

  /**
   * 发送错误响应
   */
  protected async sendError(
    context: MessageContext,
    error: string,
  ): Promise<void> {
    const errorResponse: UnifiedResponse = {
      id: `error-${Date.now()}`,
      messageId: '',
      content: [{ type: 'text', text: `Error: ${error}` }],
      timestamp: Date.now(),
      done: true,
    };
    await this.send(errorResponse, context);
  }
}

/**
 * 渠道适配器管理器
 *
 * 管理多个渠道适配器，提供统一的消息分发
 */
export interface ChannelAdapterManager {
  /**
   * 注册渠道适配器
   */
  register(adapter: ChannelAdapter): void;

  /**
   * 获取渠道适配器
   */
  get(channelType: ChannelType): ChannelAdapter | undefined;

  /**
   * 初始化所有适配器
   */
  initializeAll(): Promise<void>;

  /**
   * 关闭所有适配器
   */
  closeAll(): Promise<void>;

  /**
   * 获取所有适配器的健康状态
   */
  healthCheckAll(): Promise<
    Record<string, { healthy: boolean; message?: string }>
  >;
}

/**
 * 渠道适配器管理器实现
 */
export class DefaultChannelAdapterManager implements ChannelAdapterManager {
  private adapters: Map<ChannelType, ChannelAdapter> = new Map();

  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.channelType)) {
      throw new Error(
        `Channel adapter already registered: ${adapter.channelType}`,
      );
    }
    this.adapters.set(adapter.channelType, adapter);
  }

  get(channelType: ChannelType): ChannelAdapter | undefined {
    return this.adapters.get(channelType);
  }

  async initializeAll(): Promise<void> {
    const initPromises = Array.from(this.adapters.values()).map((adapter) =>
      adapter.initialize(),
    );
    await Promise.all(initPromises);
  }

  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.adapters.values()).map((adapter) =>
      adapter.close(),
    );
    await Promise.all(closePromises);
    this.adapters.clear();
  }

  async healthCheckAll(): Promise<
    Record<string, { healthy: boolean; message?: string }>
  > {
    const results: Record<string, { healthy: boolean; message?: string }> = {};
    for (const [type, adapter] of this.adapters) {
      results[type] = await adapter.healthCheck();
    }
    return results;
  }
}
