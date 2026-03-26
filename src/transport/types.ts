// ─── Transport Types ────────────────────────────────────────────────────────

import type { SessionManager } from '../session/types.js';
import type { MemoryService } from '../memory/types.js';

// ─── CLI Types ─────────────────────────────────────────────────────────────

import type { Interface } from 'readline';

/**
 * CLI transport options.
 */
export interface CLITransportOptions {
  /** Session ID to use (optional) */
  sessionId?: string;

  /** LLM provider to use */
  provider?: string;

  /** Welcome message to display */
  welcomeMessage?: string;

  /** Session manager for CLI commands (optional) */
  sessionManager?: SessionManager;

  /** Memory service for CLI commands (optional) */
  memory?: MemoryService;

  /** External readline interface to use (optional) */
  rl?: Interface;

  /** Abort callback for cancelling agent execution */
  abort?: () => void;
}

// ─── HTTP Types ─────────────────────────────────────────────────────────────

/**
 * HTTP transport options.
 */
export interface HTTPTransportOptions {
  /** Port to listen on */
  port?: number;

  /** Host to bind to */
  host?: string;
}

/**
 * Chat request body.
 */
export interface ChatRequest {
  /** User message */
  message: string;

  /** Session ID (optional, creates new if not provided) */
  sessionId?: string;
}

/**
 * Chat response.
 */
export interface ChatResponse {
  /** Agent response */
  response: string;

  /** Session ID */
  sessionId: string;

  /** Number of iterations */
  iterations: number;

  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Session list response.
 */
export interface SessionListResponse {
  /** Array of session metadata */
  sessions: Array<{
    id: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
  }>;
}

// ─── Error Types ────────────────────────────────────────────────────────────

/**
 * Transport error.
 */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}
