// ─── Feishu Types ──────────────────────────────────────────────────────────

/**
 * 飞书应用配置
 */
export interface FeishuConfig {
  /** 应用 ID (App ID) */
  appId: string;

  /** 应用密钥 (App Secret) */
  appSecret: string;

  /** 加密密钥 (Encrypt Key，可选) */
  encryptKey?: string;

  /** 验证令牌 (Verification Token，可选) */
  verificationToken?: string;
}

/**
 * 飞书消息事件
 */
export interface FeishuMessageEvent {
  /** 事件类型 */
  type: string;

  /** 消息类型 */
  msgType: string;

  /** 消息内容 */
  content: string;

  /** 消息 ID */
  messageId: string;

  /** 根消息 ID */
  rootId?: string;

  /** 父消息 ID */
  parentId?: string;

  /** 发送者 ID */
  sender: {
    senderId: {
      unionId: string;
      userId: string;
      openId: string;
    };
    senderType: string;
    tenantKey: string;
  };

  /** 会话信息 */
  message: {
    chatId: string;
    messageType: string;
    content: string;
    createTime: number;
    updateTime: number;
  };

  /** 聊天类型 (p2p/group) */
  chatType: 'p2p' | 'group';

  /** 租户密钥 */
  tenantKey: string;
}

/**
 * 飞书消息内容 - 文本
 */
export interface FeishuTextContent {
  text: string;
}

/**
 * 飞书消息内容 - 富文本
 */
export interface FeishuRichTextContent {
  richText: Array<Array<{
    tag: string;
    text?: string;
    href?: string;
    imageKey?: string;
  }>>;
}

/**
 * 飞书消息内容 - 图片
 */
export interface FeishuImageContent {
  imageKey: string;
}

/**
 * 飞书消息内容 - 文件
 */
export interface FeishuFileContent {
  fileKey: string;
  fileName: string;
  fileSize: number;
  fileType: string;
}

/**
 * 飞书消息内容 - 卡片
 */
export interface FeishuCardContent {
  type: string;
  config?: {
    wideScreenMode?: boolean;
    enableForward?: boolean;
  };
  elements?: Array<{
    tag: string;
    text?: {
      tag: string;
      content: string;
    };
    actions?: Array<{
      tag: string;
      text: {
        tag: string;
        content: string;
      };
      type: string;
      value: Record<string, unknown>;
    }>;
  }>;
}

/**
 * 飞书消息内容联合类型
 */
export type FeishuContent =
  | FeishuTextContent
  | FeishuRichTextContent
  | FeishuImageContent
  | FeishuFileContent
  | FeishuCardContent;

/**
 * 发送消息选项
 */
export interface FeishuSendOptions {
  /** 接收者 ID */
  receiveId: string;

  /** 接收者类型 (open_id/user_id/union_id/email/chat_id) */
  receiveIdType: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id';

  /** 消息类型 */
  msgType: 'text' | 'post' | 'image' | 'file' | 'interactive';

  /** 消息内容 */
  content: string;

  /** 租户密钥 (可选) */
  tenantKey?: string;
}

/**
 * 发送消息响应
 */
export interface FeishuSendResponse {
  /** 消息 ID */
  messageId: string;

  /** 创建时间 */
  createTime: string;
}

/**
 * 飞书用户信息
 */
export interface FeishuUserInfo {
  /** 用户 Open ID */
  openId: string;

  /** 用户 Union ID */
  unionId: string;

  /** 用户 ID */
  userId: string;

  /** 用户名称 */
  name: string;

  /** 用户头像 */
  avatarUrl?: string;

  /** 用户邮箱 */
  email?: string;

  /** 用户手机 */
  mobile?: string;
}

/**
 * 飞书群组信息
 */
export interface FeishuGroupInfo {
  /** 群组 ID */
  chatId: string;

  /** 群组名称 */
  name: string;

  /** 群组描述 */
  description?: string;

  /** 群主 ID */
  ownerId: string;

  /** 群成员数量 */
  memberCount: number;
}

/**
 * 卡片消息构建器选项
 */
export interface CardBuilderOptions {
  /** 卡片标题 */
  title?: string;

  /** 是否启用宽屏模式 */
  wideScreenMode?: boolean;

  /** 是否启用转发 */
  enableForward?: boolean;
}

/**
 * 卡片元素
 */
export interface CardElement {
  tag: string;
  text?: {
    tag: string;
    content: string;
  };
}

/**
 * 流式卡片更新事件
 */
export interface StreamingCardEvent {
  /** 消息 ID */
  messageId: string;

  /** 更新内容 */
  content: string;

  /** 是否完成 */
  done: boolean;
}
