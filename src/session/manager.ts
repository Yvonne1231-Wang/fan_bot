import type {
  SessionManager,
  SessionManagerOptions,
  SessionMeta,
  SessionStore,
  Session,
  Message,
} from './types.js';
import type { LLMClient, ContentBlock } from '../llm/types.js';
import {
  summarizeMessages,
  createSummaryMessage,
  isSummaryMessage,
  estimateTokens,
  countContentParts,
  findMaxContentPartsMessage,
} from './summarizer.js';
import { createDebug } from '../utils/debug.js';
import { SessionArchive } from './archive.js';

const log = createDebug('session:manager');

const DEFAULT_MAX_CONTEXT_MESSAGES = 40;
const DEFAULT_MAX_TOKENS = 100000;
const FRESH_ZONE_SIZE = 10;
const COMPRESS_BATCH_SIZE = 10;
const MAX_CONTENT_PARTS_PER_MESSAGE = 100;

export interface CompressionConfig {
  maxTokens?: number;
  freshZoneSize?: number;
  compressBatchSize?: number;
}

export class SessionManagerImpl implements SessionManager {
  private readonly store: SessionStore;
  private readonly maxContextMessages: number;
  private readonly createdAtCache = new Map<string, number>();
  private llmClient: LLMClient | null = null;
  private compressionConfig: CompressionConfig;
  private llmClientMissingWarned = false;
  private archive: SessionArchive | null = null;

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.maxContextMessages =
      options.maxContextMessages ?? DEFAULT_MAX_CONTEXT_MESSAGES;
    this.compressionConfig = {};
  }

  setLLMClient(client: LLMClient): void {
    this.llmClient = client;
  }

  setCompressionConfig(config: CompressionConfig): void {
    this.compressionConfig = { ...this.compressionConfig, ...config };
  }

  setArchive(archive: SessionArchive): void {
    this.archive = archive;
  }

  async load(id: string): Promise<Message[]> {
    const session = await this.store.load(id);

    if (session) {
      this.createdAtCache.set(id, session.meta.createdAt);
      return session.messages;
    }

    return [];
  }

  async save(id: string, messages: Message[]): Promise<void> {
    const now = Date.now();
    const createdAt = this.createdAtCache.get(id) ?? now;

    const session: Session = {
      meta: {
        id,
        createdAt,
        updatedAt: now,
        messageCount: messages.length,
      },
      messages,
    };

    await this.store.save(session);
  }

  prune(messages: Message[]): Message[] {
    if (messages.length <= this.maxContextMessages) {
      return messages;
    }

    const dropped = messages.length - this.maxContextMessages;
    log.debug(`Context pruned: dropped ${dropped} oldest messages`);

    const firstMessage = messages[0];
    const toPrune = messages.slice(1);
    const keepCount = this.maxContextMessages - 1;

    if (keepCount <= 0) {
      return [firstMessage];
    }

    let keptFromEnd = toPrune.slice(-keepCount);

    const toolUseIds = new Set<string>();
    for (const msg of keptFromEnd) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolUseIds.add(block.id);
        }
      }
    }

    const toolResultIds = new Set<string>();
    for (const msg of keptFromEnd) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }

    const additionalMessages: Message[] = [];
    for (const msg of toPrune.slice(0, -keepCount)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && toolResultIds.has(block.id)) {
          additionalMessages.push(msg);
          break;
        }
        if (block.type === 'tool_result' && toolUseIds.has(block.tool_use_id)) {
          additionalMessages.push(msg);
          break;
        }
      }
    }

    if (additionalMessages.length > 0) {
      keptFromEnd = [...additionalMessages, ...keptFromEnd];
    }

    // 最终校验：移除没有对应 tool_use 的 orphaned tool_result，
    // 避免 Anthropic API 报错
    const result = [firstMessage, ...keptFromEnd];
    const allToolUseIds = new Set<string>();
    for (const msg of result) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          allToolUseIds.add(block.id);
        }
      }
    }

    for (const msg of result) {
      msg.content = msg.content.filter((block) => {
        if (block.type === 'tool_result') {
          const hasParent = allToolUseIds.has(block.tool_use_id);
          if (!hasParent) {
            log.warn(`Removing orphaned tool_result (tool_use_id: ${block.tool_use_id})`);
          }
          return hasParent;
        }
        return true;
      });
    }

    // 移除变为空内容的消息
    return result.filter((msg) => msg.content.length > 0);
  }

  /**
   * 拆分 content parts 超限的消息。
   * 当单条消息的 content blocks 数量超过 MAX_CONTENT_PARTS_PER_MESSAGE 时，
   * 将其拆分为多条消息，每条不超过限制。
   * 主要处理 user 消息中堆积大量 tool_result 的场景。
   */
  private splitOverflowingMessages(messages: Message[]): Message[] {
    const result: Message[] = [];

    for (const msg of messages) {
      const partsCount = countContentParts(msg);
      if (partsCount <= MAX_CONTENT_PARTS_PER_MESSAGE) {
        result.push(msg);
        continue;
      }

      log.warn(
        `Splitting message with ${partsCount} content parts into chunks of ${MAX_CONTENT_PARTS_PER_MESSAGE}`,
      );

      // 按 tool_result 和非 tool_result 分组
      const nonToolResults = msg.content.filter(
        (b) => b.type !== 'tool_result',
      );
      const toolResults = msg.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_result' }> =>
          b.type === 'tool_result',
      );

      // 第一条消息：原始文本 + tool_use + 前 N 个 tool_result
      const firstChunkSize = Math.min(
        MAX_CONTENT_PARTS_PER_MESSAGE - nonToolResults.length,
        toolResults.length,
      );

      if (firstChunkSize > 0) {
        result.push({
          role: msg.role,
          content: [...nonToolResults, ...toolResults.slice(0, firstChunkSize)],
        });
      } else if (nonToolResults.length > 0) {
        // 即使非 tool_result 部分也超限（极端情况），强制截断
        result.push({
          role: msg.role,
          content: nonToolResults.slice(0, MAX_CONTENT_PARTS_PER_MESSAGE),
        });
      }

      // 剩余 tool_result 拆分为额外的 user 消息
      let remaining = toolResults.slice(firstChunkSize);
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, MAX_CONTENT_PARTS_PER_MESSAGE);
        remaining = remaining.slice(MAX_CONTENT_PARTS_PER_MESSAGE);
        result.push({
          role: 'user',
          content: chunk,
        });
      }
    }

    return result;
  }

  async compress(messages: Message[]): Promise<Message[]> {
    if (!this.llmClient) {
      if (!this.llmClientMissingWarned) {
        log.error(
          'setLLMClient() was never called — compress() is falling back to lossy prune(). ' +
            'Ensure all bootstrap entries call sessionManager.setLLMClient(llmClient).',
        );
        this.llmClientMissingWarned = true;
      }
      return this.prune(messages);
    }

    const maxTokens = this.compressionConfig.maxTokens ?? DEFAULT_MAX_TOKENS;
    const freshZoneSize =
      this.compressionConfig.freshZoneSize ?? FRESH_ZONE_SIZE;
    const compressBatchSize =
      this.compressionConfig.compressBatchSize ?? COMPRESS_BATCH_SIZE;

    const currentTokens = estimateTokens(messages);
    if (currentTokens <= maxTokens) {
      const overflowInfo = findMaxContentPartsMessage(messages);
      if (overflowInfo && overflowInfo.count > MAX_CONTENT_PARTS_PER_MESSAGE) {
        log.warn(
          `Message at index ${overflowInfo.index} has ${overflowInfo.count} content parts (limit: ${MAX_CONTENT_PARTS_PER_MESSAGE}), splitting`,
        );
        return this.splitOverflowingMessages(messages);
      }
      return messages;
    }

    log.info(
      `Compressing session: ${currentTokens} tokens > ${maxTokens} limit`,
    );

    // 归档原始消息到 FTS5 索引（压缩前保存完整上下文）
    if (this.archive) {
      try {
        const sessionId = `compress-${Date.now()}`;
        this.archive.archive(sessionId, messages);
        log.debug(`Archived ${messages.length} messages before compression`);
      } catch (err) {
        log.warn(`Failed to archive messages before compression: ${err}`);
      }
    }

    // 压缩前先拆分超限消息，避免压缩后仍然超限
    let workingMessages = this.splitOverflowingMessages(messages);

    const freshZone = workingMessages.slice(-freshZoneSize);
    const compressionZone = workingMessages.slice(0, -freshZoneSize);

    if (compressionZone.length === 0) {
      return workingMessages;
    }

    const existingSummaries = compressionZone.filter(isSummaryMessage);
    const regularMessages = compressionZone.filter((m) => !isSummaryMessage(m));

    if (regularMessages.length < compressBatchSize) {
      return [...compressionZone, ...freshZone];
    }

    let currentRegular = regularMessages;
    let currentSummaries = existingSummaries;
    const maxRounds = 5;

    for (let round = 0; round < maxRounds; round++) {
      if (currentRegular.length < compressBatchSize) break;

      const toCompress = currentRegular.slice(0, compressBatchSize);
      currentRegular = currentRegular.slice(compressBatchSize);

      log.debug(
        `Compressing ${toCompress.length} messages into summary (round ${round + 1})`,
      );

      const summary = await summarizeMessages(toCompress, this.llmClient);
      const summaryMessage = createSummaryMessage(
        summary,
        0,
        compressBatchSize,
        toCompress.length,
      );

      currentSummaries = [...currentSummaries, summaryMessage];

      const candidateTokens = estimateTokens([
        ...currentSummaries,
        ...currentRegular,
        ...freshZone,
      ]);

      if (candidateTokens <= maxTokens) {
        log.debug(`Token budget met after ${round + 1} rounds`);
        break;
      }
    }

    const compressed = [...currentSummaries, ...currentRegular, ...freshZone];

    const newTokens = estimateTokens(compressed);
    log.info(
      `Compression complete: ${currentTokens} -> ${newTokens} tokens (${Math.round((1 - newTokens / currentTokens) * 100)}% reduction)`,
    );

    return compressed;
  }

  async list(): Promise<SessionMeta[]> {
    return this.store.list();
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }
}

export function createSessionManager(
  options: SessionManagerOptions,
): SessionManager {
  return new SessionManagerImpl(options);
}
