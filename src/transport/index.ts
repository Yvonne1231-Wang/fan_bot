// ─── Transport Module ───────────────────────────────────────────────────────

// Unified Types
export type {
  ChannelType,
  MessageContext,
  ContentBlockType,
  TextContentBlock,
  ImageContentBlock,
  FileContentBlock,
  CardContentBlock,
  CardAction,
  ContentBlock,
  UnifiedMessage,
  ResponseBlockType,
  TextResponseBlock,
  MarkdownResponseBlock,
  ImageResponseBlock,
  FileResponseBlock,
  CardResponseBlock,
  ActionResponseBlock,
  ResponseBlock,
  UnifiedResponse,
  StreamEventType,
  StreamEvent,
  MessageTransformer,
  UnifiedMessageFactory,
  OriginalResponseFactory,
} from './unified.js';

// Channel Adapter
export {
  BaseChannelAdapter,
  DefaultChannelAdapterManager,
  type ChannelAdapterConfig,
  type MessageHandler,
  type StreamMessageHandler,
  type ChannelAdapter,
  type ChannelAdapterManager,
} from './adapter.js';

// CLI Adapter
export {
  CLIChannelAdapter,
  createCLIAdapter,
  parseArgs,
  printHelp,
  type CLIAdapterConfig,
} from './cli-adapter.js';

// HTTP Adapter
export {
  HTTPChannelAdapter,
  createHTTPAdapter,
  type HTTPAdapterConfig,
  type HTTPChatRequest,
  type HTTPChatResponse,
  type HTTPSessionListResponse,
} from './http-adapter.js';
