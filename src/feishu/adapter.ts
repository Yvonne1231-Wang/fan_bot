// ─── Feishu Channel Adapter ────────────────────────────────────────────────

import { mkdir, writeFile } from 'fs/promises';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  BaseChannelAdapter,
  type ChannelAdapterConfig,
} from '../transport/adapter.js';
import type {
  UnifiedMessage,
  UnifiedResponse,
  StreamEvent,
  ContentBlock,
  MessageContext,
  ImageContentBlock,
  FileContentBlock,
} from '../transport/unified.js';
import { FeishuService, type FeishuServiceConfig } from './service.js';
import type { FeishuMessageEvent } from './types.js';
import { FeishuCardClient } from './card-client.js';
import { StreamingCardRenderer } from './card.js';
import { createDebug } from '../utils/debug.js';
import { setToolContext } from '../tools/registry.js';

const log = createDebug('feishu:adapter');

/**
 * 飞书适配器配置
 */
export interface FeishuAdapterConfig extends Partial<ChannelAdapterConfig> {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  enableStreamingCard?: boolean;
  useLark?: boolean;
}

/**
 * 飞书渠道适配器
 */
export class FeishuChannelAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu' as const;
  readonly name = 'Feishu Adapter';

  private feishuConfig: FeishuAdapterConfig;
  private feishuService: FeishuService;
  private wsClient: lark.WSClient | null = null;
  private eventDispatcher: lark.EventDispatcher | null = null;
  private streamingCardMessageId: string | null = null;
  private streamingCardContent: string = '';

  /** 活跃的卡片渲染器映射：messageId -> renderer */
  private activeRenderers = new Map<string, StreamingCardRenderer>();

  /** 消息去重：messageId -> timestamp (TTL 12小时) */
  private messageDedupMap = new Map<string, number>();
  private dedupCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly DEDUP_TTL_MS = 12 * 60 * 60 * 1000; // 12小时
  private readonly DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5分钟清扫

  /** 消息过期时间阈值（毫秒），默认30分钟 */
  private readonly MESSAGE_EXPIRE_MS = 30 * 60 * 1000;

  /** 并发串行化：accountId:chatId -> Promise chain */
  private chatTaskQueues = new Map<string, Promise<void>>();

  /** 每个 chatId 对应的 AbortController，用于停止正在执行的任务 */
  private chatAbortControllers = new Map<string, AbortController>();

  /** 停止指令关键词 */
  private static readonly STOP_KEYWORDS = [
    '/stop',
    '停止',
    '停下',
    '暂停',
    '取消',
    'cancel',
    'abort',
  ];

  constructor(config: FeishuAdapterConfig) {
    super({ ...config, channelType: 'feishu' });
    this.feishuConfig = config;

    const serviceConfig: FeishuServiceConfig = {
      appId: config.appId,
      appSecret: config.appSecret,
      encryptKey: config.encryptKey,
      verificationToken: config.verificationToken,
      useLark: config.useLark,
    };
    this.feishuService = new FeishuService(serviceConfig);
  }

  /**
   * 检测消息是否是停止指令
   */
  private isStopCommand(text: string): boolean {
    const normalizedText = text.trim().toLowerCase();
    return FeishuChannelAdapter.STOP_KEYWORDS.some(
      (keyword) =>
        normalizedText === keyword.toLowerCase() ||
        normalizedText.startsWith(keyword.toLowerCase() + ' ') ||
        normalizedText.startsWith('/' + keyword.toLowerCase().replace('/', '')),
    );
  }

  /**
   * 停止指定 chatId 正在执行的任务
   *
   * @param chatId - 聊天 ID
   * @returns 是否成功停止了任务
   */
  private stopChatTask(chatId: string): boolean {
    const controller = this.chatAbortControllers.get(chatId);
    if (controller && !controller.signal.aborted) {
      log.info(`Stopping task for chat: ${chatId}`);
      controller.abort();
      return true;
    }
    return false;
  }

  /**
   * 获取指定 chatId 的 AbortSignal
   *
   * @param chatId - 聊天 ID
   * @returns AbortSignal 或 undefined
   */
  getAbortSignal(chatId: string): AbortSignal | undefined {
    return this.chatAbortControllers.get(chatId)?.signal;
  }

  protected async doInitialize(): Promise<void> {
    log.info('Initializing Feishu adapter...');

    this.eventDispatcher = new lark.EventDispatcher({
      verificationToken: this.feishuConfig.verificationToken,
      encryptKey: this.feishuConfig.encryptKey,
    });

    this.eventDispatcher.register({
      'im.message.receive_v1': (data: unknown) => {
        log.debug('Received message event via WebSocket');
        this.handleWebSocketMessage(data);
      },
      'im.message.card.action': (data: unknown) => {
        log.debug('Received card action event');
        this.handleCardAction(data);
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.feishuConfig.appId,
      appSecret: this.feishuConfig.appSecret,
      domain: this.feishuConfig.useLark ? lark.Domain.Lark : lark.Domain.Feishu,
    });

    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    });

    this.startDedupCleanup();

    log.info('Feishu adapter initialized, waiting for messages...');
  }

  private startDedupCleanup(): void {
    this.dedupCleanupInterval = setInterval(() => {
      this.cleanupExpiredDedupEntries();
    }, this.DEDUP_CLEANUP_INTERVAL_MS);
  }

  private cleanupExpiredDedupEntries(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [messageId, timestamp] of this.messageDedupMap.entries()) {
      if (now - timestamp > this.DEDUP_TTL_MS) {
        this.messageDedupMap.delete(messageId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.debug(`Cleaned up ${cleaned} expired dedup entries`);
    }
  }

  private isDuplicateMessage(messageId: string): boolean {
    const now = Date.now();
    const existing = this.messageDedupMap.get(messageId);
    if (existing && now - existing < this.DEDUP_TTL_MS) {
      log.debug(`Duplicate message detected: ${messageId}`);
      return true;
    }
    this.messageDedupMap.set(messageId, now);
    return false;
  }

  private isMessageExpired(createTime: number): boolean {
    const now = Date.now();
    const age = now - createTime;
    if (age > this.MESSAGE_EXPIRE_MS) {
      log.debug(`Message expired: age=${age}ms > ${this.MESSAGE_EXPIRE_MS}ms`);
      return true;
    }
    return false;
  }

  private async enqueueFeishuChatTask(
    accountId: string,
    chatId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const key = `${accountId}:${chatId}`;
    const existingQueue = this.chatTaskQueues.get(key);

    const newQueue = (async () => {
      if (existingQueue) {
        await existingQueue;
      }
      await task();
    })();

    this.chatTaskQueues.set(key, newQueue);

    try {
      await newQueue;
    } finally {
      if (this.chatTaskQueues.get(key) === newQueue) {
        this.chatTaskQueues.delete(key);
      }
    }
  }

  async send(
    response: UnifiedResponse,
    context: MessageContext,
  ): Promise<void> {
    const receiveId = context.metadata.chatId as string;
    const receiveIdType =
      (context.metadata.receiveIdType as 'chat_id' | 'open_id') || 'chat_id';
    const originalMessageId = context.metadata.originalMessageId as string;
    if (!receiveId) {
      log.error('No chatId in context');
      return;
    }
    const textContent = this.extractTextContent(response);
    log.info(
      `[cron-send] receiveId=${receiveId} receiveIdType=${receiveIdType} hasOriginalMsgId=${!!originalMessageId}`,
    );
    if (originalMessageId) {
      await this.feishuService.replyMessage(
        originalMessageId,
        'text',
        JSON.stringify({ text: textContent }),
      );
    } else {
      await this.feishuService.sendTextMessage(
        receiveId,
        receiveIdType,
        textContent,
      );
    }
  }

  async sendStream(event: StreamEvent, context: MessageContext): Promise<void> {
    if (!this.feishuConfig.enableStreamingCard) {
      if (event.type === 'done' && event.response) {
        await this.send(event.response, context);
      }
      return;
    }

    const receiveId = context.metadata.chatId as string;

    switch (event.type) {
      case 'start':
        this.streamingCardContent = '';
        this.streamingCardMessageId = null;
        break;

      case 'delta':
        if (event.delta) {
          this.streamingCardContent += event.delta;
          await this.updateStreamingCard(receiveId);
        }
        break;

      case 'done':
        if (this.streamingCardMessageId) {
          await this.feishuService.updateStreamingCard({
            messageId: this.streamingCardMessageId,
            content: this.streamingCardContent,
            done: true,
          });
        } else if (event.response) {
          await this.send(event.response, context);
        }
        this.streamingCardMessageId = null;
        break;

      case 'error':
        log.error('Stream error:', event.error);
        if (this.streamingCardMessageId) {
          await this.feishuService.updateCardMessage(
            this.streamingCardMessageId,
            this.feishuService.buildStreamingCard(
              '错误',
              `发生错误: ${event.error}`,
              true,
            ),
          );
        }
        this.streamingCardMessageId = null;
        break;
    }
  }

  protected async doClose(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
    }
    if (this.dedupCleanupInterval) {
      clearInterval(this.dedupCleanupInterval);
      this.dedupCleanupInterval = null;
    }
    log.info('Feishu adapter closed');
  }

  getFeishuService(): FeishuService {
    return this.feishuService;
  }

  private async handleWebSocketMessage(event: unknown): Promise<void> {
    log.debug('Received WebSocket event:', JSON.stringify(event));

    const feishuEvent = event as {
      type?: string;
      event_type?: string;
      [key: string]: unknown;
    };

    const isMessageEvent =
      feishuEvent.type === 'im.message.receive_v1' ||
      feishuEvent.event_type === 'im.message.receive_v1' ||
      feishuEvent.event;

    if (isMessageEvent) {
      const messageEvent = this.parseMessageEvent(feishuEvent);
      if (messageEvent) {
        await this.processFeishuMessage(messageEvent);
      } else {
        log.warn('Failed to parse message event');
      }
    }
  }

  private async handleCardAction(event: unknown): Promise<void> {
    try {
      const cardEvent = event as {
        action?: {
          value?: Record<string, string>;
        };
        message?: {
          message_id?: string;
          chat_id?: string;
        };
      };

      const actionValue = cardEvent.action?.value;
      if (actionValue?.action === 'stop') {
        const messageId = cardEvent.message?.message_id;
        log.info('Stop button clicked for message:', messageId);

        if (messageId) {
          const renderer = this.activeRenderers.get(messageId);
          if (renderer) {
            renderer.abort();
            await renderer.onAborted();
            this.activeRenderers.delete(messageId);
          }
        }
      }
    } catch (error) {
      log.error('Failed to handle card action:', error);
    }
  }

  private parseMessageEvent(event: unknown): FeishuMessageEvent | null {
    try {
      const e = event as {
        event?: {
          sender?: {
            sender_id?: {
              union_id?: string;
              user_id?: string;
              open_id?: string;
            };
            sender_type?: string;
            tenant_key?: string;
          };
          message?: {
            message_id?: string;
            root_id?: string;
            parent_id?: string;
            create_time?: string;
            chat_id?: string;
            message_type?: string;
            content?: string;
            mentions?: Array<{
              id?: {
                open_id?: string;
                union_id?: string;
                user_id?: string;
              };
              key?: string;
              name?: string;
              tenant_key?: string;
            }>;
          };
          chat_type?: string;
          tenant_key?: string;
        };
        message?: {
          message_id?: string;
          root_id?: string;
          parent_id?: string;
          create_time?: string;
          chat_id?: string;
          chat_type?: string;
          message_type?: string;
          content?: string;
          mentions?: Array<{
            id?: {
              open_id?: string;
              union_id?: string;
              user_id?: string;
            };
            key?: string;
            name?: string;
            tenant_key?: string;
          }>;
        };
        sender?: {
          sender_id?: { union_id?: string; user_id?: string; open_id?: string };
          sender_type?: string;
          tenant_key?: string;
        };
        chat_type?: string;
        tenant_key?: string;
      };

      const sender = e.event?.sender ?? e.sender;
      const message = e.event?.message ?? e.message;
      const chatType =
        e.event?.chat_type ?? e.chat_type ?? e.message?.chat_type;
      const tenantKey = e.event?.tenant_key ?? e.tenant_key;

      if (!sender || !message) {
        log.warn('Missing sender or message in event');
        return null;
      }

      const rawMentions = message.mentions;
      const mentions = rawMentions?.map((m) => ({
        id: {
          open_id: m.id?.open_id ?? '',
          union_id: m.id?.union_id ?? '',
          user_id: m.id?.user_id ?? '',
        },
        key: m.key ?? '',
        name: m.name ?? '',
        tenant_key: m.tenant_key,
      }));

      return {
        type: 'im.message.receive_v1',
        msgType: message.message_type ?? 'text',
        content: message.content ?? '',
        messageId: message.message_id ?? '',
        rootId: message.root_id,
        parentId: message.parent_id,
        sender: {
          senderId: {
            unionId: sender.sender_id?.union_id ?? '',
            userId: sender.sender_id?.user_id ?? '',
            openId: sender.sender_id?.open_id ?? '',
          },
          senderType: sender.sender_type ?? '',
          tenantKey: sender.tenant_key ?? '',
        },
        message: {
          chatId: message.chat_id ?? '',
          messageType: message.message_type ?? '',
          content: message.content ?? '',
          createTime: Number(message.create_time) || Date.now(),
          updateTime: Date.now(),
          chatType: '',
        },
        chatType: (chatType as 'p2p' | 'group') ?? 'p2p',
        tenantKey: tenantKey ?? '',
        mentions,
      };
    } catch (error) {
      log.error('Failed to parse message event:', error);
      return null;
    }
  }

  private async processFeishuMessage(event: FeishuMessageEvent): Promise<void> {
    if (!this.messageHandler) {
      log.error('No message handler set');
      return;
    }

    if (this.isDuplicateMessage(event.messageId)) {
      log.info(`Skipping duplicate message: ${event.messageId}`);
      return;
    }

    if (this.isMessageExpired(event.message.createTime)) {
      log.info(
        `Skipping expired message: ${event.messageId}, age: ${Date.now() - event.message.createTime}ms`,
      );
      return;
    }

    const accountId = this.feishuConfig.appId;
    const chatId = event.message.chatId;

    const messageText = this.extractMessageText(event);
    if (this.isStopCommand(messageText)) {
      const stopped = this.stopChatTask(chatId);
      if (stopped) {
        log.info(`Task stopped for chat: ${chatId}`);
        await this.feishuService.replyMessage(
          event.messageId,
          'text',
          JSON.stringify({ text: '✅ 已停止当前任务' }),
        );
      } else {
        await this.feishuService.replyMessage(
          event.messageId,
          'text',
          JSON.stringify({ text: '当前没有正在执行的任务' }),
        );
      }
      return;
    }

    await this.enqueueFeishuChatTask(accountId, chatId, async () => {
      await this.doProcessMessage(event);
    });
  }

  /**
   * 从事件中提取消息文本
   */
  private extractMessageText(event: FeishuMessageEvent): string {
    try {
      const parsed = JSON.parse(event.content);
      if (event.msgType === 'text') {
        return parsed.text || event.content;
      }
      return event.content;
    } catch {
      return event.content;
    }
  }

  private async doProcessMessage(event: FeishuMessageEvent): Promise<void> {
    if (!this.messageHandler) {
      log.error('No message handler set');
      return;
    }

    const chatId = event.message.chatId;

    setToolContext({
      channel: 'feishu',
      chatId,
      userId: event.sender.senderId.openId,
      sessionId:
        event.chatType === 'group'
          ? event.message.chatId
          : event.sender.senderId.openId,
    });

    const unifiedMessage = this.toUnifiedMessage(event);
    await this.downloadMediaIfNeeded(unifiedMessage, event.messageId);

    let typingReactionId: string | null = null;
    const abortController = new AbortController();
    this.chatAbortControllers.set(chatId, abortController);

    try {
      log.info('Adding typing indicator...');
      typingReactionId = await this.feishuService.addTypingIndicator(
        event.messageId,
      );
      log.info('Typing reaction ID:', typingReactionId);

      if (this.feishuConfig.enableStreamingCard) {
        const cardClient = new FeishuCardClient(this.feishuService);
        const renderer = new StreamingCardRenderer(
          cardClient,
          chatId,
          event.messageId,
        );

        if (event.sender.senderId.openId) {
          renderer.setMentionUser(event.sender.senderId.openId);
        }

        renderer.setAbortCallback(() => {
          abortController.abort();
        });

        this.activeRenderers.set(event.messageId, renderer);

        await renderer.init();

        let hasComplexContent = false;

        await this.messageHandler(unifiedMessage, {
          onThinking: async (text: string) => {
            hasComplexContent = true;
            await renderer.onThinking(text);
          },
          onThinkingStop: async () => {
            await renderer.onThinkingStop();
          },
          onToolStart: async (
            toolName: string,
            input: Record<string, unknown> | undefined,
            parentToolUseId?: string | null,
            toolUseId?: string,
          ) => {
            hasComplexContent = true;
            await renderer.onToolStart(
              toolName,
              input,
              parentToolUseId ?? null,
              toolUseId,
            );
          },
          onToolEnd: async (
            toolName: string,
            output: string,
            parentToolUseId?: string | null,
          ) => {
            await renderer.onToolEnd(toolName, output, parentToolUseId ?? null);
          },
          onContentDelta: async (delta: string) => {
            await renderer.onContentDelta(delta);
          },
          onComplete: async () => {
            await renderer.onComplete();
            this.activeRenderers.delete(event.messageId);
          },
          onError: async (error: string) => {
            await renderer.onError(error);
            this.activeRenderers.delete(event.messageId);
          },
        });

        if (!hasComplexContent) {
        }
      } else {
        const response = await this.messageHandler(unifiedMessage);

        if (typingReactionId) {
          await this.feishuService.removeTypingIndicator(
            event.messageId,
            typingReactionId,
          );
        }

        await this.send(response, unifiedMessage.context);
      }

      if (typingReactionId) {
        await this.feishuService.removeTypingIndicator(
          event.messageId,
          typingReactionId,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (abortController.signal.aborted) {
        log.info(`Task aborted for chat: ${chatId}`);
      } else {
        log.error('Failed to process message:', error);
        log.error('Error details:', {
          type: typeof error,
          constructor: error?.constructor?.name,
          message: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
          keys: error && typeof error === 'object' ? Object.keys(error) : [],
          ...(error as object),
        });

        if (typingReactionId) {
          await this.feishuService.removeTypingIndicator(
            event.messageId,
            typingReactionId,
          );
        }

        await this.sendError(unifiedMessage.context, errorMessage);
      }
    } finally {
      this.chatAbortControllers.delete(chatId);
    }
  }

  private toUnifiedMessage(event: FeishuMessageEvent): UnifiedMessage {
    const content = this.parseFeishuContent(
      event.msgType,
      event.content,
      event.mentions,
    );
    log.debug(
      'toUnifiedMessage: msgType=',
      event.msgType,
      'content types=',
      content.map((c) => c.type),
    );
    const isGroup = event.chatType === 'group';
    return {
      id: event.messageId,
      context: {
        channel: 'feishu',
        userId: event.sender.senderId.openId,
        sessionId: isGroup
          ? event.message.chatId
          : event.sender.senderId.openId,
        groupId: isGroup ? event.message.chatId : undefined,
        dmId: isGroup ? undefined : event.sender.senderId.openId,
        originalMessageId: event.messageId,
        metadata: {
          chatId: event.message.chatId,
          originalMessageId: event.messageId,
          tenantKey: event.tenantKey,
          msgType: event.msgType,
        },
      },
      content,
      timestamp: event.message.createTime,
      stream: this.feishuConfig.enableStreamingCard,
    };
  }

  private parseFeishuContent(
    msgType: string,
    rawContent: string,
    mentions?: FeishuMessageEvent['mentions'],
  ): ContentBlock[] {
    try {
      const parsed = JSON.parse(rawContent);

      switch (msgType) {
        case 'text': {
          let text = parsed.text || rawContent;
          if (mentions && mentions.length > 0) {
            for (const m of mentions) {
              const replacement = `${m.name}（"open_id":"${m.id.open_id}"）`;
              text = text.replace(m.key, replacement);
            }
          }
          return [{ type: 'text', text }];
        }
        case 'post':
          return this.parseRichText(parsed);
        case 'image':
          return [{ type: 'image', url: parsed.image_key }];
        case 'file':
          return [
            {
              type: 'file',
              url: parsed.file_key,
              name: parsed.file_name || 'unknown',
            },
          ];
        default:
          return [{ type: 'text', text: rawContent }];
      }
    } catch {
      return [{ type: 'text', text: rawContent }];
    }
  }

  private parseRichText(parsed: {
    rich_text?: Array<
      Array<{ tag?: string; text?: string; href?: string; image_key?: string }>
    >;
  }): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    log.debug(
      'parseRichText: raw parsed=',
      JSON.stringify(parsed).slice(0, 500),
    );
    log.debug('parseRichText: keys=', Object.keys(parsed));

    const richText =
      parsed.rich_text ?? (parsed as any).content ?? (parsed as any).post ?? [];
    log.debug('parseRichText: richText=', richText?.length);

    if (richText && Array.isArray(richText)) {
      for (const paragraph of richText) {
        for (const el of paragraph) {
          log.debug(
            'parseRichText: el tag=',
            el.tag,
            'image_key=',
            el.image_key,
          );
          if (el.tag === 'img' && el.image_key) {
            blocks.push({ type: 'image', url: el.image_key });
          } else if (el.tag === 'text' && el.text) {
            blocks.push({ type: 'text', text: el.text });
          }
        }
      }
    }

    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
  }

  private extractTextContent(response: UnifiedResponse): string {
    const parts: string[] = [];

    for (const block of response.content) {
      switch (block.type) {
        case 'text':
          parts.push(block.text);
          break;
        case 'markdown':
          parts.push(block.text);
          break;
        case 'card':
          if (block.title) {
            parts.push(`### ${block.title}`);
          }
          parts.push(block.content);
          break;
      }
    }

    return parts.join('\n');
  }

  private async updateStreamingCard(chatId: string): Promise<void> {
    if (!this.streamingCardMessageId) {
      const response = await this.feishuService.sendCardMessage(
        chatId,
        'chat_id',
        this.feishuService.buildStreamingCard(
          'AI 助手',
          this.streamingCardContent,
          false,
        ),
      );
      this.streamingCardMessageId = response.messageId;
    } else {
      await this.feishuService.updateStreamingCard({
        messageId: this.streamingCardMessageId,
        content: this.streamingCardContent,
        done: false,
      });
    }
  }

  private async downloadMediaIfNeeded(
    message: UnifiedMessage,
    messageId: string,
  ): Promise<void> {
    const mediaBlocks = message.content.filter(
      (b) => b.type === 'image' || b.type === 'file',
    );

    log.debug(
      'downloadMediaIfNeeded: mediaBlocks=',
      mediaBlocks.length,
      'content types=',
      message.content.map((b) => b.type),
    );

    if (mediaBlocks.length === 0) return;

    const tmpDir = `${process.env.TMPDIR ?? '/tmp'}/fan_bot_media`;
    await mkdir(tmpDir, { recursive: true });

    for (const block of mediaBlocks) {
      if (block.type === 'image') {
        const imgBlock = block as ImageContentBlock;
        if (!imgBlock.localPath) {
          log.debug(
            'downloadMediaIfNeeded: downloading image from',
            imgBlock.url,
            'messageId=',
            messageId,
          );
          try {
            const buffer = await this.feishuService.downloadResource(
              messageId,
              imgBlock.url,
              'image',
            );
            log.debug(
              'downloadMediaIfNeeded: downloaded buffer size=',
              buffer.length,
            );
            const ext = this.guessExtension(buffer, 'png');
            const localPath = `${tmpDir}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
            await writeFile(localPath, buffer);
            imgBlock.localPath = localPath;
            log.debug('downloadMediaIfNeeded: saved to', localPath);
          } catch (err) {
            log.error('downloadMediaIfNeeded: ERROR downloading image:', err);
          }
        }
      } else if (block.type === 'file') {
        const fileBlock = block as FileContentBlock;
        if (!fileBlock.localPath) {
          try {
            const buffer = await this.feishuService.downloadResource(
              messageId,
              fileBlock.url,
              'file',
            );
            const ext = fileBlock.name.split('.').pop() ?? 'bin';
            const localPath = `${tmpDir}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
            await writeFile(localPath, buffer);
            fileBlock.localPath = localPath;
            log.debug('Downloaded file to:', localPath);
          } catch (err) {
            log.error('Failed to download file:', err);
          }
        }
      }
    }
  }

  private guessExtension(buffer: Buffer, fallback: string): string {
    if (buffer.length >= 4) {
      if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      )
        return 'png';
      if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
        return 'jpg';
      if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46)
        return 'gif';
      if (
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46
      )
        return 'webp';
    }
    return fallback;
  }
}

export function createFeishuAdapter(
  config: FeishuAdapterConfig,
): FeishuChannelAdapter {
  return new FeishuChannelAdapter(config);
}
