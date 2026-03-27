// ─── Feishu Module ──────────────────────────────────────────────────────────

// Types
export type {
  FeishuConfig,
  FeishuMessageEvent,
  FeishuTextContent,
  FeishuRichTextContent,
  FeishuImageContent,
  FeishuFileContent,
  FeishuCardContent,
  FeishuContent,
  FeishuSendOptions,
  FeishuSendResponse,
  FeishuUserInfo,
  FeishuGroupInfo,
  CardBuilderOptions,
  CardElement,
  StreamingCardEvent,
} from './types.js';

// Service
export {
  FeishuService,
  createFeishuService,
  type FeishuServiceConfig,
} from './service.js';

// Adapter
export {
  FeishuChannelAdapter,
  createFeishuAdapter,
  type FeishuAdapterConfig,
} from './adapter.js';
