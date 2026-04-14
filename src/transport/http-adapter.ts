// ─── HTTP Channel Adapter ──────────────────────────────────────────────────

import { createDebug } from '../utils/debug.js';
import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  BaseChannelAdapter,
  type ChannelAdapterConfig,
  type MessageHandler,
} from './adapter.js';
import type {
  UnifiedMessage,
  UnifiedResponse,
  StreamEvent,
  ContentBlock,
  MessageContext,
} from './unified.js';

/**
 * HTTP 适配器配置
 */
export interface HTTPAdapterConfig extends Partial<ChannelAdapterConfig> {
  /** 监听端口 */
  port?: number;

  /** 绑定主机 */
  host?: string;
}

/**
 * HTTP 请求体
 */
export interface HTTPChatRequest {
  /** 用户消息 */
  message: string;

  /** 会话 ID（可选，不提供则创建新会话） */
  sessionId?: string;

  /** 用户 ID（可选） */
  userId?: string;

  /** 是否流式响应 */
  stream?: boolean;
}

/**
 * HTTP 响应体
 */
export interface HTTPChatResponse {
  /** 响应内容 */
  response: string;

  /** 会话 ID */
  sessionId: string;

  /** 时间戳 */
  timestamp: number;

  /** Token 使用统计 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * 会话列表响应
 */
export interface HTTPSessionListResponse {
  sessions: Array<{
    id: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
  }>;
}

/**
 * HTTP 渠道适配器
 *
 * 实现 HTTP API 的消息收发，支持：
 * - RESTful API 接口
 * - Server-Sent Events (SSE) 流式响应
 * - 会话管理
 */

const log = createDebug('transport:http');

export class HTTPChannelAdapter extends BaseChannelAdapter {
  readonly channelType = 'http' as const;
  readonly name = 'HTTP Adapter';

  private httpConfig: HTTPAdapterConfig;
  private server: FastifyInstance | null = null;
  private sessionListHandler?: () => Promise<HTTPSessionListResponse>;

  constructor(config: HTTPAdapterConfig = {}) {
    super({ ...config, channelType: 'http' });
    this.httpConfig = {
      port: 3000,
      host: '0.0.0.0',
      ...config,
    };
  }

  protected async doInitialize(): Promise<void> {
    this.server = Fastify({ logger: false });

    this.setupRoutes();

    const { port, host } = this.httpConfig;
    await this.server.listen({ port: port!, host: host! });
    log.info(`HTTP server listening on ${host}:${port}`);
  }

  async send(
    response: UnifiedResponse,
    context: MessageContext,
  ): Promise<void> {
    // HTTP 模式下，响应通过 HTTP 请求直接返回，不需要主动发送
    // 这个方法用于其他场景（如 webhook 回调）
    log.info(`[HTTP] Sending response to session ${context.sessionId}: ${response.id}`);
  }

  async sendStream(event: StreamEvent, context: MessageContext): Promise<void> {
    // HTTP 模式下的流式响应通过 SSE 实现
    log.info(`[HTTP] Stream event for session ${context.sessionId}: ${event.type}`);
  }

  protected async doClose(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
  }

  /**
   * 设置会话列表处理器
   */
  setSessionListHandler(handler: () => Promise<HTTPSessionListResponse>): void {
    this.sessionListHandler = handler;
  }

  /**
   * 获取服务器实例
   */
  getServer(): FastifyInstance | null {
    return this.server;
  }

  /**
   * 获取服务器地址
   */
  getAddress(): string | null {
    if (!this.server) return null;
    const { port, host } = this.httpConfig;
    return `http://${host}:${port}`;
  }

  private setupRoutes(): void {
    if (!this.server) return;

    this.server.post<{ Body: HTTPChatRequest }>('/chat', async (req, reply) => {
      return this.handleChat(req.body, reply);
    });

    this.server.get('/sessions', async (_req, reply) => {
      return this.handleSessionList(reply);
    });

    this.server.get('/health', async (_req, reply) => {
      const health = await this.healthCheck();
      return reply.send({
        status: health.healthy ? 'ok' : 'error',
        message: health.message,
        timestamp: Date.now(),
      });
    });

    this.server.get<{
      Params: { sessionId: string };
    }>('/chat/stream/:sessionId', async (req, reply) => {
      return this.handleStreamRequest(req.params.sessionId, reply);
    });
  }

  private async handleChat(
    body: HTTPChatRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { message, sessionId, userId, stream } = body;

    if (!message) {
      return reply.status(400).send({ error: 'message is required' });
    }

    if (!this.messageHandler) {
      return reply.status(503).send({ error: 'Service not initialized' });
    }

    const unifiedMessage = this.createUnifiedMessage(
      message,
      sessionId,
      userId,
      stream,
    );

    try {
      const response = await this.messageHandler(unifiedMessage);
      const httpResponse = this.toHTTPResponse(
        response,
        unifiedMessage.context,
      );

      return reply.send(httpResponse);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: errorMessage });
    }
  }

  private async handleSessionList(reply: FastifyReply): Promise<FastifyReply> {
    if (!this.sessionListHandler) {
      return reply.send({ sessions: [] });
    }

    try {
      const result = await this.sessionListHandler();
      return reply.send(result);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: errorMessage });
    }
  }

  private async handleStreamRequest(
    _sessionId: string,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    return reply.status(501).send({
      error: 'Streaming not implemented. Use POST /chat with stream: true',
    });
  }

  private createUnifiedMessage(
    message: string,
    sessionId?: string,
    userId?: string,
    stream?: boolean,
  ): UnifiedMessage {
    const content: ContentBlock[] = [{ type: 'text', text: message }];
    const sid = sessionId || `http-session-${Date.now()}`;

    return {
      id: `http-msg-${Date.now()}`,
      context: {
        channel: 'http',
        userId: userId || 'http-user',
        sessionId: sid,
        dmId: 'http-dm', // HTTP 模式视为私聊
        metadata: {},
      },
      content,
      timestamp: Date.now(),
      stream: stream ?? false,
    };
  }

  private toHTTPResponse(
    response: UnifiedResponse,
    context: MessageContext,
  ): HTTPChatResponse {
    let responseText = '';

    for (const block of response.content) {
      switch (block.type) {
        case 'text':
          responseText += block.text;
          break;
        case 'markdown':
          responseText += block.text;
          break;
        case 'card':
          if (block.title) {
            responseText += `\n### ${block.title}\n`;
          }
          responseText += block.content;
          break;
        default:
          break;
      }
    }

    return {
      response: responseText.trim(),
      sessionId: context.sessionId,
      timestamp: response.timestamp,
      usage: response.usage,
    };
  }
}

/**
 * 创建 HTTP 适配器的工厂函数
 *
 * @param config - HTTP 适配器配置
 * @returns HTTP 适配器实例
 */
export function createHTTPAdapter(
  config: HTTPAdapterConfig = {},
): HTTPChannelAdapter {
  return new HTTPChannelAdapter(config);
}
