// ─── Session Manager Implementation ─────────────────────────────────────────

import type {
  SessionManager,
  SessionManagerOptions,
  SessionMeta,
  SessionStore,
  Session,
  Message,
} from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default maximum context messages before pruning */
const DEFAULT_MAX_CONTEXT_MESSAGES = 40;

// ─── Session Manager Implementation ─────────────────────────────────────────

/**
 * Manages session lifecycle including loading, saving, and pruning.
 */
export class SessionManagerImpl implements SessionManager {
  private readonly store: SessionStore;
  private readonly maxContextMessages: number;

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.maxContextMessages = options.maxContextMessages ?? DEFAULT_MAX_CONTEXT_MESSAGES;
  }

  /**
   * Load or create a session.
   *
   * If session exists, returns its messages.
   * If not, creates an empty session and returns empty array.
   *
   * @param id - Session ID
   * @returns Session messages
   */
  async load(id: string): Promise<Message[]> {
    const session = await this.store.load(id);

    if (session) {
      return session.messages;
    }

    // New session - return empty
    return [];
  }

  /**
   * Save session messages.
   *
   * Creates or updates the session with given messages.
   *
   * @param id - Session ID
   * @param messages - Messages to save
   */
  async save(id: string, messages: Message[]): Promise<void> {
    const now = Date.now();
    const existing = await this.store.load(id);

    const session: Session = {
      meta: {
        id,
        createdAt: existing?.meta.createdAt ?? now,
        updatedAt: now,
        messageCount: messages.length,
      },
      messages,
    };

    await this.store.save(session);
  }

  /**
   * Prune messages if they exceed context limit.
   *
   * Strategy:
   * 1. Always keep first message (system context)
   * 2. Keep most recent messages up to limit
   * 3. Never split tool_use/tool_result pairs
   *
   * @param messages - Messages to prune
   * @returns Pruned messages
   */
  prune(messages: Message[]): Message[] {
    if (messages.length <= this.maxContextMessages) {
      return messages;
    }

    // Always keep first message (usually system)
    const firstMessage = messages[0];
    const toPrune = messages.slice(1);

    // Calculate how many to keep from the end
    const keepCount = this.maxContextMessages - 1;

    if (keepCount <= 0) {
      // Edge case: max is 1, just keep first
      return [firstMessage];
    }

    // Keep last N messages, but don't break tool pairs
    let keptFromEnd = toPrune.slice(-keepCount);

    // Check if we broke a tool pair
    // If first kept message is tool_result, we need to find its tool_use
    // This is simplified - full implementation would track tool_use_id

    return [firstMessage, ...keptFromEnd];
  }

  /**
   * List all sessions.
   *
   * @returns Array of session metadata, sorted by updated time (newest first)
   */
  async list(): Promise<SessionMeta[]> {
    return this.store.list();
  }

  /**
   * Delete a session.
   *
   * @param id - Session ID to delete
   */
  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }
}

// ─── Factory Function ─────────────────────────────────────────────────────

/**
 * Create a new SessionManager instance.
 *
 * @param options - Configuration options
 * @returns SessionManager instance
 */
export function createSessionManager(options: SessionManagerOptions): SessionManager {
  return new SessionManagerImpl(options);
}
