import type {
  SessionManager,
  SessionManagerOptions,
  SessionMeta,
  SessionStore,
  Session,
  Message,
} from './types.js';
import type { LLMClient } from '../llm/types.js';
import {
  summarizeMessages,
  createSummaryMessage,
  isSummaryMessage,
  estimateTokens,
} from './summarizer.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('session:manager');

const DEFAULT_MAX_CONTEXT_MESSAGES = 40;
const DEFAULT_MAX_TOKENS = 100000;
const FRESH_ZONE_SIZE = 10;
const COMPRESS_BATCH_SIZE = 10;

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

    return [firstMessage, ...keptFromEnd];
  }

  async compress(messages: Message[]): Promise<Message[]> {
    if (!this.llmClient) {
      log.warn('No LLM client set, falling back to simple pruning');
      return this.prune(messages);
    }

    const maxTokens = this.compressionConfig.maxTokens ?? DEFAULT_MAX_TOKENS;
    const freshZoneSize = this.compressionConfig.freshZoneSize ?? FRESH_ZONE_SIZE;
    const compressBatchSize = this.compressionConfig.compressBatchSize ?? COMPRESS_BATCH_SIZE;

    const currentTokens = estimateTokens(messages);
    if (currentTokens <= maxTokens) {
      return messages;
    }

    log.info(`Compressing session: ${currentTokens} tokens > ${maxTokens} limit`);

    const freshZone = messages.slice(-freshZoneSize);
    const compressionZone = messages.slice(0, -freshZoneSize);

    if (compressionZone.length === 0) {
      return messages;
    }

    const existingSummaries = compressionZone.filter(isSummaryMessage);
    const regularMessages = compressionZone.filter((m) => !isSummaryMessage(m));

    if (regularMessages.length < compressBatchSize) {
      return [...compressionZone, ...freshZone];
    }

    const toCompress = regularMessages.slice(0, compressBatchSize);
    const remaining = regularMessages.slice(compressBatchSize);

    log.debug(`Compressing ${toCompress.length} messages into summary`);

    const summary = await summarizeMessages(toCompress, this.llmClient);
    const summaryMessage = createSummaryMessage(
      summary,
      0,
      compressBatchSize,
      toCompress.length,
    );

    const compressed = [...existingSummaries, summaryMessage, ...remaining, ...freshZone];

    const newTokens = estimateTokens(compressed);
    log.info(`Compression complete: ${currentTokens} -> ${newTokens} tokens (${Math.round((1 - newTokens / currentTokens) * 100)}% reduction)`);

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
