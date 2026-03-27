// ─── Unified Message Types ─────────────────────────────────────────────────

/**
 * 支持的消息来源渠道
 */
export type ChannelType = 'cli' | 'http' | 'feishu' | 'slack' | 'discord';

/**
 * 消息来源上下文，包含渠道特定的元数据
 */
export interface MessageContext {
  /** 消息来源渠道 */
  channel: ChannelType;

  /** 用户唯一标识 */
  userId: string;

  /** 会话唯一标识 */
  sessionId: string;

  /** 群组 ID（群聊场景） */
  groupId?: string;

  /** 私聊 ID（私聊场景） */
  dmId?: string;

  /** 原始消息 ID（用于引用/回复） */
  originalMessageId?: string;

  /** 渠道特定元数据 */
  metadata: Record<string, unknown>;
}

/**
 * 消息内容块类型
 */
export type ContentBlockType = 'text' | 'image' | 'file' | 'card';

/**
 * 文本内容块
 */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/**
 * 图片内容块
 */
export interface ImageContentBlock {
  type: 'image';
  url: string;
  alt?: string;
}

/**
 * 文件内容块
 */
export interface FileContentBlock {
  type: 'file';
  url: string;
  name: string;
  size?: number;
  mimeType?: string;
}

/**
 * 卡片内容块（用于富媒体展示）
 */
export interface CardContentBlock {
  type: 'card';
  title?: string;
  content: string;
  actions?: CardAction[];
}

/**
 * 卡片操作按钮
 */
export interface CardAction {
  type: 'primary' | 'default' | 'danger';
  text: string;
  value: string;
}

/**
 * 统一消息内容块
 */
export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | FileContentBlock
  | CardContentBlock;

/**
 * 统一消息格式
 *
 * 所有渠道的消息都会被转换为这个统一格式，
 * 以便 Agent 核心逻辑可以统一处理。
 */
export interface UnifiedMessage {
  /** 消息唯一标识 */
  id: string;

  /** 消息来源上下文 */
  context: MessageContext;

  /** 消息内容块列表 */
  content: ContentBlock[];

  /** 消息创建时间戳 */
  timestamp: number;

  /** 是否需要流式响应 */
  stream?: boolean;

  /** 父消息 ID（用于回复链） */
  parentMessageId?: string;
}

/**
 * 响应内容块类型
 */
export type ResponseBlockType =
  | 'text'
  | 'markdown'
  | 'image'
  | 'file'
  | 'card'
  | 'action';

/**
 * 文本响应块
 */
export interface TextResponseBlock {
  type: 'text';
  text: string;
}

/**
 * Markdown 响应块
 */
export interface MarkdownResponseBlock {
  type: 'markdown';
  text: string;
}

/**
 * 图片响应块
 */
export interface ImageResponseBlock {
  type: 'image';
  url: string;
  alt?: string;
}

/**
 * 文件响应块
 */
export interface FileResponseBlock {
  type: 'file';
  url: string;
  name: string;
  size?: number;
  mimeType?: string;
}

/**
 * 卡片响应块
 */
export interface CardResponseBlock {
  type: 'card';
  title?: string;
  content: string;
  actions?: CardAction[];
}

/**
 * 操作响应块（用于请求用户确认或输入）
 */
export interface ActionResponseBlock {
  type: 'action';
  actionType: 'confirm' | 'input' | 'select';
  prompt: string;
  options?: { label: string; value: string }[];
  default?: string;
}

/**
 * 统一响应内容块
 */
export type ResponseBlock =
  | TextResponseBlock
  | MarkdownResponseBlock
  | ImageResponseBlock
  | FileResponseBlock
  | CardResponseBlock
  | ActionResponseBlock;

/**
 * 统一响应格式
 *
 * Agent 处理后的响应会被转换为这个统一格式，
 * 然后由各渠道适配器转换为渠道特定的响应格式。
 */
export interface UnifiedResponse {
  /** 响应唯一标识 */
  id: string;

  /** 关联的消息 ID */
  messageId: string;

  /** 响应内容块列表 */
  content: ResponseBlock[];

  /** 响应创建时间戳 */
  timestamp: number;

  /** 是否为流式响应的结束标记 */
  done?: boolean;

  /** Token 使用统计 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };

  /** 迭代次数 */
  iterations?: number;
}

/**
 * 流式响应事件类型
 */
export type StreamEventType = 'start' | 'delta' | 'done' | 'error';

/**
 * 流式响应事件
 */
export interface StreamEvent {
  /** 事件类型 */
  type: StreamEventType;

  /** 关联的响应 ID */
  responseId: string;

  /** 关联的消息 ID */
  messageId: string;

  /** 增量内容（delta 事件） */
  delta?: string;

  /** 完整响应（done 事件） */
  response?: UnifiedResponse;

  /** 错误信息（error 事件） */
  error?: string;
}

/**
 * 消息转换器函数类型
 */
export type MessageTransformer<TInput, TOutput> = (
  input: TInput,
) => TOutput | Promise<TOutput>;

/**
 * 从原始消息创建统一消息的工厂函数类型
 */
export type UnifiedMessageFactory<TOriginal> = (
  original: TOriginal,
  channel: ChannelType,
) => UnifiedMessage | Promise<UnifiedMessage>;

/**
 * 将统一响应转换为原始响应的工厂函数类型
 */
export type OriginalResponseFactory<TOriginal> = (
  response: UnifiedResponse,
  context: MessageContext,
) => TOriginal | Promise<TOriginal>;
