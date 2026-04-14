// ─── Session Module ─────────────────────────────────────────────────────────

export {
  type Session,
  type SessionMeta,
  type SessionStore,
  type SessionManager,
  type SessionManagerOptions,
} from './types.js';

export { JSONLStore, type JSONLStoreOptions } from './store.js';
export {
  SessionManagerImpl,
  createSessionManager,
  type CompressionConfig,
} from './manager.js';
export {
  summarizeMessages,
  createSummaryMessage,
  isSummaryMessage,
  estimateTokens,
  type SummaryMessage,
} from './summarizer.js';
export {
  SessionArchive,
  type ArchiveSearchOptions,
  type ArchiveResult,
  type ArchiveStats,
} from './archive.js';
