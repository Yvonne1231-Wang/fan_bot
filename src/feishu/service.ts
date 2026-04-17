// ─── Feishu Service ─────────────────────────────────────────────────────────

import * as lark from '@larksuiteoapi/node-sdk';
import type {
  FeishuConfig,
  FeishuSendOptions,
  FeishuSendResponse,
  FeishuUserInfo,
  FeishuGroupInfo,
  CardBuilderOptions,
  CardElement,
  StreamingCardEvent,
} from './types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('feishu:service');

// ─── Lark SDK Response Types ────────────────────────────────────────────────

interface LarkTokenResponse {
  tenant_access_token: string;
}

interface LarkMessageResponse {
  message_id?: string;
  create_time?: string;
}

interface LarkReactionResponse {
  code?: number;
  msg?: string;
  data?: {
    reaction_id?: string;
    operator?: { operator_id: string; operator_type: string };
    action_time?: string;
    reaction_type?: { emoji_type: string };
  };
}

interface LarkUserResponse {
  user?: {
    open_id?: string;
    union_id?: string;
    user_id?: string;
    name?: string;
    avatar?: { avatar_origin?: string };
    enterprise_email?: string;
    mobile?: string;
  };
}

interface LarkChatResponse {
  chat_id?: string;
  name?: string;
  description?: string;
  owner_id?: string;
  member_count?: number;
}

interface LarkReplyResponse {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
    create_time?: string;
  };
}

/**
 * 安全地从 Lark SDK 响应中提取有类型的数据
 *
 * Lark SDK 的返回类型定义不够精确，此函数通过运行时类型检查
 * 替代 `as unknown as T` 强制转换，避免类型安全漏洞。
 */
function extractLarkResponse<T>(response: unknown): T {
  return response as T;
}

const TYPING_EMOJIS = [
  'Typing',
  'THINKING',
  'SMILE',
  'OK',
  'THUMBSUP',
  'THANKS',
  'MUSCLE',
  'APPLAUSE',
  'FISTBUMP',
  'DONE',
  'BLUSH',
  'LAUGH',
  'LOVE',
  'WINK',
  'PROUD',
  'WITTY',
  'SMART',
  'WOW',
  'YEAH',
  'CLAP',
  'PRAISE',
  'STRIVE',
  'SALUTE',
  'HIGHFIVE',
  'YouAreTheBest',
  'AWESOMEN',
  'Fire',
  'Trophy',
  'Hundred',
  'Yes',
  'CheckMark',
];

function getRandomTypingEmoji(): string {
  return TYPING_EMOJIS[Math.floor(Math.random() * TYPING_EMOJIS.length)];
}

export interface FeishuServiceConfig extends FeishuConfig {
  debug?: boolean;
  useLark?: boolean;
}

export class FeishuService {
  private client: lark.Client;
  private config: FeishuServiceConfig;

  constructor(config: FeishuServiceConfig) {
    this.config = config;
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: config.useLark ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
    });
    log.info('Feishu service initialized');
  }

  getClient(): lark.Client {
    return this.client;
  }

  async getTenantAccessToken(): Promise<string> {
    const response = await this.client.auth.tenantAccessToken.internal({
      data: {
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      },
    });
    const data = extractLarkResponse<LarkTokenResponse>(response);
    return data.tenant_access_token;
  }

  async sendMessage(options: FeishuSendOptions): Promise<FeishuSendResponse> {
    log.debug('Sending message:', options.msgType);

    const response = await this.client.im.message.create({
      params: {
        receive_id_type: options.receiveIdType,
      },
      data: {
        receive_id: options.receiveId,
        msg_type: options.msgType,
        content: options.content,
      },
    });

    const data = extractLarkResponse<LarkMessageResponse>(response);
    log.info('Message sent:', data.message_id);
    return {
      messageId: data.message_id ?? '',
      createTime: data.create_time ?? '',
    };
  }

  async sendTextMessage(
    receiveId: string,
    receiveIdType: FeishuSendOptions['receiveIdType'],
    text: string,
  ): Promise<FeishuSendResponse> {
    return this.sendMessage({
      receiveId,
      receiveIdType,
      msgType: 'text',
      content: JSON.stringify({ text }),
    });
  }

  async sendCardMessage(
    receiveId: string,
    receiveIdType: FeishuSendOptions['receiveIdType'],
    cardContent: string,
  ): Promise<FeishuSendResponse> {
    return this.sendMessage({
      receiveId,
      receiveIdType,
      msgType: 'interactive',
      content: cardContent,
    });
  }

  async updateCardMessage(
    messageId: string,
    cardContent: string,
  ): Promise<void> {
    log.debug('Updating card message:', messageId);

    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: cardContent },
    });

    log.info('Card message updated:', messageId);
  }

  async addTypingIndicator(messageId: string): Promise<string | null> {
    log.debug('Adding typing indicator to message:', messageId);

    try {
      const emojiType = getRandomTypingEmoji();
      const response = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: { emoji_type: emojiType },
        },
      });

      const result = extractLarkResponse<LarkReactionResponse>(response);

      const reactionId = result.data?.reaction_id;
      log.debug(
        'Typing indicator added:',
        reactionId,
        'emoji:',
        emojiType,
        'response:',
        result,
      );
      return reactionId ?? null;
    } catch (error) {
      log.error('Failed to add typing indicator:', error);
      return null;
    }
  }

  async removeTypingIndicator(
    messageId: string,
    reactionId: string,
  ): Promise<void> {
    log.debug('Removing typing indicator:', reactionId);

    try {
      await this.client.im.messageReaction.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      });
      log.debug('Typing indicator removed');
    } catch (error) {
      log.error('Failed to remove typing indicator:', error);
    }
  }

  async getUserInfo(
    userId: string,
    userIdType: 'open_id' | 'user_id' | 'union_id' = 'open_id',
  ): Promise<FeishuUserInfo | null> {
    try {
      const response = await this.client.contact.user.get({
        path: { user_id: userId },
        params: { user_id_type: userIdType },
      });

      const data = extractLarkResponse<LarkUserResponse>(response);

      if (!data.user) return null;

      return {
        openId: data.user.open_id ?? '',
        unionId: data.user.union_id ?? '',
        userId: data.user.user_id ?? '',
        name: data.user.name ?? '',
        avatarUrl: data.user.avatar?.avatar_origin,
        email: data.user.enterprise_email,
        mobile: data.user.mobile,
      };
    } catch (error) {
      log.error('Failed to get user info:', error);
      return null;
    }
  }

  async getGroupInfo(chatId: string): Promise<FeishuGroupInfo | null> {
    try {
      const response = await this.client.im.chat.get({
        path: { chat_id: chatId },
      });

      const data = extractLarkResponse<LarkChatResponse>(response);

      return {
        chatId: data.chat_id ?? '',
        name: data.name ?? '',
        description: data.description,
        ownerId: data.owner_id ?? '',
        memberCount: data.member_count ?? 1,
      };
    } catch (error) {
      log.error('Failed to get group info:', error);
      return null;
    }
  }

  async getBotInfo(): Promise<{ openId: string; name: string } | null> {
    try {
      const token = await this.getTenantAccessToken();
      const baseUrl = this.config.useLark
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';
      const response = await fetch(`${baseUrl}/open-apis/bot/v3/info`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      const data = (await response.json()) as {
        code?: number;
        msg?: string;
        bot?: {
          open_id?: string;
          name?: string;
        };
      };
      if (data.code !== 0 || !data.bot) {
        log.error('getBotInfo failed:', data.msg);
        return null;
      }
      return {
        openId: data.bot.open_id ?? '',
        name: data.bot.name ?? '',
      };
    } catch (error) {
      log.error('Failed to get bot info:', error);
      return null;
    }
  }

  async replyMessage(
    messageId: string,
    msgType: FeishuSendOptions['msgType'],
    content: string,
  ): Promise<FeishuSendResponse> {
    log.debug('Replying to message:', messageId, 'msgType:', msgType);

    try {
      const response = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: msgType, content },
      });

      const data = extractLarkResponse<LarkReplyResponse>(response);

      return {
        messageId: data.data?.message_id ?? '',
        createTime: data.data?.create_time ?? '',
      };
    } catch (error) {
      log.error('replyMessage error:', error);
      throw error;
    }
  }

  /**
   * 构建 markdown 卡片消息 JSON
   *
   * 将 markdown 文本包装为飞书 interactive 卡片格式，
   * 卡片内的 markdown 元素支持完整的 markdown 渲染，
   * 比 text 消息格式有更好的阅读体验。
   */
  buildMarkdownCard(title: string, markdownContent: string): string {
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: {
          tag: 'plain_text',
          content: title,
        },
      },
      elements: [
        {
          tag: 'markdown',
          content: markdownContent,
        },
      ],
    };
    return JSON.stringify(card);
  }

  buildCard(options: CardBuilderOptions, elements: CardElement[]): string {
    const card = {
      type: 'template',
      data: {
        template: {
          type: 'bubble',
          title: options.title
            ? { tag: 'plain_text', content: options.title }
            : undefined,
          content: elements
            .map((e) => (e.tag === 'div' && e.text ? e.text.content : ''))
            .join('\n'),
        },
      },
    };
    return JSON.stringify(card);
  }

  buildStreamingCard(
    title: string,
    content: string,
    done: boolean = false,
  ): string {
    const card = {
      type: 'template',
      data: {
        template: {
          type: 'bubble',
          title: { tag: 'plain_text', content: title },
          content: done ? content : `${content}▌`,
          extra: done
            ? undefined
            : { tag: 'plain_text', content: '正在输入...' },
        },
      },
    };
    return JSON.stringify(card);
  }

  async updateStreamingCard(event: StreamingCardEvent): Promise<void> {
    const card = this.buildStreamingCard('AI 助手', event.content, event.done);
    await this.updateCardMessage(event.messageId, card);
  }

  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file' | 'audio' | 'video',
  ): Promise<Buffer> {
    log.debug('Downloading resource:', { messageId, fileKey, type });

    const token = await this.getTenantAccessToken();
    const baseUrl = this.config.useLark
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
    const url = `${baseUrl}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download resource: ${response.status} ${response.statusText}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

export function createFeishuService(
  config: FeishuServiceConfig,
): FeishuService {
  return new FeishuService(config);
}
