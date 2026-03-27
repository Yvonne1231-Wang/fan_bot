// ─── Session Types ──────────────────────────────────────────────────────────

import type { Message } from '../llm/types.js';

export type { Message };

// ─── Core Types ─────────────────────────────────────────────────────────────

/**
 * Session metadata.
 */
export interface SessionMeta {
  /** Unique session ID */
  id: string;

  /** Creation timestamp */
  createdAt: number;

  /** Last updated timestamp */
  updatedAt: number;

  /** Number of messages in session */
  messageCount: number;
}

/**
 * Session data structure.
 */
export interface Session {
  /** Session metadata */
  meta: SessionMeta;

  /** Message history */
  messages: Message[];
}

// ─── Store Interface ────────────────────────────────────────────────────────

/**
 * Interface for session storage backend.
 */
export interface SessionStore {
  /**
   * Load session data by ID.
   *
   * @param id - Session ID
   * @returns Session data or null if not found
   */
  load(id: string): Promise<Session | null>;

  /**
   * Save session data.
   *
   * @param session - Session to save
   */
  save(session: Session): Promise<void>;

  /**
   * Delete a session.
   *
   * @param id - Session ID to delete
   */
  delete(id: string): Promise<void>;

  /**
   * List all available session IDs.
   *
   * @returns Array of session metadata
   */
  list(): Promise<SessionMeta[]>;
}

// ─── Manager Options ────────────────────────────────────────────────────────

/**
 * Options for creating a SessionManager.
 */
export interface SessionManagerOptions {
  store: SessionStore;
  maxContextMessages?: number;
}

export interface SessionManager {
  setLLMClient(client: import('../llm/types.js').LLMClient): void;
  load(id: string): Promise<Message[]>;
  save(id: string, messages: Message[]): Promise<void>;
  prune(messages: Message[]): Message[];
  compress(messages: Message[]): Promise<Message[]>;
  list(): Promise<SessionMeta[]>;
  delete(id: string): Promise<void>;
}
