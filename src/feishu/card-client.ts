// ─── Feishu Card Client Adapter ─────────────────────────────────────

import type { FeishuService } from './service.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('feishu:card-client');

/**
 * 飞书交互卡片 JSON 体积上限（字节）
 * 飞书官方限制约 30KB，这里留 1KB 余量做边界保护
 */
const CARD_JSON_BYTE_LIMIT = 29 * 1024;

/**
 * 从飞书 SDK 抛出的 axios error 中提取服务端返回的错误摘要
 *
 * 历史问题：axios 的默认 error.message 只含 HTTP 状态码，
 * 飞书真实的 `{code, msg}` 被埋在 response.data 里，排障时拿不到。
 * 这里统一抽取出来并做长度裁剪，保证日志可读。
 */
function summarizeFeishuError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const err = error as {
    message?: string;
    response?: { status?: number; data?: unknown };
  };
  const status = err.response?.status;
  const data = err.response?.data;
  let dataStr = '';
  try {
    dataStr =
      typeof data === 'string'
        ? data
        : JSON.stringify(data ?? {}, null, 0).slice(0, 500);
  } catch {
    dataStr = '[unserializable body]';
  }
  return `status=${status ?? 'n/a'} msg=${err.message ?? ''} body=${dataStr}`;
}

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

    const byteSize = Buffer.byteLength(cardJson, 'utf8');
    if (byteSize > CARD_JSON_BYTE_LIMIT) {
      log.error(
        `Card JSON too large for create: ${byteSize} bytes > ${CARD_JSON_BYTE_LIMIT}, aborting`,
      );
      return null;
    }

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
      log.error(
        `Failed to create interactive card: ${summarizeFeishuError(error)}`,
      );
      return null;
    }
  }

  /**
   * 更新交互式卡片
   *
   * 额外兜底（除 StreamingCardRenderer 内部已有的字节截断外）：
   *   - 卡片 JSON > 29KB 时直接拒绝，不烧一次网络/配额；
   *   - 捕获到的错误会抽取飞书服务端 `{code, msg}` 写入日志，便于定位
   *     "大小合法但仍然 400" 的问题（如 schema 违规、表格数超限等）。
   */
  async patchInteractiveCard(
    messageId: string,
    cardJson: string,
  ): Promise<boolean> {
    log.debug('Patching interactive card:', messageId);

    const byteSize = Buffer.byteLength(cardJson, 'utf8');
    if (byteSize > CARD_JSON_BYTE_LIMIT) {
      log.error(
        `Card JSON too large for patch: ${byteSize} bytes > ${CARD_JSON_BYTE_LIMIT}, skip`,
      );
      return false;
    }

    try {
      await this.service.updateCardMessage(messageId, cardJson);
      return true;
    } catch (error) {
      log.error(
        `Failed to patch interactive card: ${summarizeFeishuError(error)}`,
      );
      return false;
    }
  }
}
