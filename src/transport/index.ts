// ─── Transport Module ───────────────────────────────────────────────────────

// CLI Transport
export {
  startCLI,
  parseArgs,
  printHelp,
  type InputHandler,
} from './cli.js';

// HTTP Transport
export {
  startHTTP,
  createServer,
  type ChatHandler,
  type SessionListHandler,
} from './http.js';

// Types
export type {
  CLITransportOptions,
  HTTPTransportOptions,
  ChatRequest,
  ChatResponse,
  SessionListResponse,
  TransportError,
} from './types.js';
