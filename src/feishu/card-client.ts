// ─── Feishu Card Client Adapter ─────────────────────────────────────

import type { FeishuService } from './service.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('feishu:card-client');

/**
 * FeishuCardClient 适配器
 *
 * 将 StreamingCardRenderer 的接口适配到 FeishuService
 */
export class FeishuCardClient {
  private service: FeishuService;

  constructor(service: FeishuService) {
    this.service = service;
  }

  /**
   * 创建交互式卡片
   */
  async createInteractiveCard(
    chatId: string,
    cardJson: string,
    replyMessageId?: string,
    threadId?: string,
  ): Promise<string | null> {
    log.debug(
      'Creating interactive card in chat:',
      chatId,
      'replyTo:',
      replyMessageId,
    );

    try {
      if (replyMessageId) {
        const response = await this.service.replyMessage(
          replyMessageId,
          'interactive',
          cardJson,
        );
        return response.messageId || null;
      } else {
        const response = await this.service.sendCardMessage(
          chatId,
          'chat_id',
          cardJson,
        );
        return response.messageId || null;
      }
    } catch (error) {
      log.error('Failed to create interactive card:', error);
      return null;
    }
  }

  /**
   * 更新交互式卡片
   */
  async patchInteractiveCard(
    messageId: string,
    cardJson: string,
  ): Promise<boolean> {
    log.debug('Patching interactive card:', messageId);

    try {
      await this.service.updateCardMessage(messageId, cardJson);
      return true;
    } catch (error) {
      log.error('Failed to patch interactive card:', error);
      return false;
    }
  }
}
