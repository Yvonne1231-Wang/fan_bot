// ─── HTTP Transport ─────────────────────────────────────────────────────────

import type {
  HTTPTransportOptions,
  ChatRequest,
  ChatResponse,
  SessionListResponse,
} from './types.js';

// ─── Placeholder Implementation ─────────────────────────────────────────────

/**
 * Start HTTP server.
 *
 * This is a placeholder implementation. Full implementation would use Fastify.
 *
 * @param options - HTTP options
 * @returns Promise that resolves when server starts
 */
export async function startHTTP(
  options: HTTPTransportOptions = {},
): Promise<void> {
  const { port = 3000, host = '0.0.0.0' } = options;

  console.log(`HTTP server would start on ${host}:${port}`);
  console.log('Note: Full HTTP implementation requires Fastify dependency');

  // Placeholder - would actually start server here
  return new Promise(() => {
    // Keep process alive
  });
}

// ─── Route Handlers (for reference) ─────────────────────────────────────────

/**
 * POST /chat handler type.
 */
export type ChatHandler = (body: ChatRequest) => Promise<ChatResponse>;

/**
 * GET /sessions handler type.
 */
export type SessionListHandler = () => Promise<SessionListResponse>;

// ─── Server Factory ─────────────────────────────────────────────────────────

/**
 * Create HTTP server (placeholder).
 *
 * Full implementation would:
 * 1. Create Fastify instance
 * 2. Register routes
 * 3. Add error handlers
 * 4. Start listening
 *
 * @param _options - Server options
 * @returns Server instance
 */
export function createServer(_options: HTTPTransportOptions = {}): unknown {
  // Placeholder - would return Fastify instance
  return null;
}
