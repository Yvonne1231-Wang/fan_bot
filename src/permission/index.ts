// ─── Permission Module ─────────────────────────────────────────────────────

import type { MessageContext, UnifiedMessage } from '../transport/unified.js';

/**
 * 权限检查结果
 */
export interface PermissionCheckResult {
  /** 是否允许 */
  allowed: boolean;

  /** 拒绝原因（如果不允许） */
  reason?: string;

  /** 建议的操作（如需要管理员权限） */
  suggestion?: string;
}

/**
 * 权限策略类型
 */
export type PermissionPolicy = 'allow' | 'deny' | 'whitelist' | 'blacklist';

/**
 * 私聊权限配置
 */
export interface DMPermissionConfig {
  /** 默认策略 */
  defaultPolicy: PermissionPolicy;

  /** 白名单用户 ID 列表 */
  whitelist: string[];

  /** 黑名单用户 ID 列表 */
  blacklist: string[];

  /** 允许的工具列表（空表示允许所有） */
  allowedTools: string[];

  /** 禁止的工具列表 */
  forbiddenTools: string[];
}

/**
 * 群聊权限配置
 */
export interface GroupPermissionConfig {
  /** 默认策略 */
  defaultPolicy: PermissionPolicy;

  /** 白名单群组 ID 列表 */
  whitelist: string[];

  /** 黑名单群组 ID 列表 */
  blacklist: string[];

  /** 允许的工具列表（空表示允许所有） */
  allowedTools: string[];

  /** 禁止的工具列表 */
  forbiddenTools: string[];

  /** 是否允许 @机器人 */
  allowMention: boolean;

  /** 是否允许直接调用（不 @） */
  allowDirectCall: boolean;

  /** 群聊中允许的非管理员用户 ID 列表（白名单） */
  allowedUsers: string[];

  /** 群聊消息频率限制：每个用户每分钟最大消息数（0表示不限制） */
  rateLimitPerUser: number;

  /** 群聊消息频率限制窗口（毫秒） */
  rateLimitWindowMs: number;
}

/**
 * 权限配置
 */
export interface PermissionConfig {
  /** 私聊权限配置 */
  dm: DMPermissionConfig;

  /** 群聊权限配置 */
  group: GroupPermissionConfig;

  /** 管理员用户 ID 列表（拥有所有权限） */
  admins: string[];
}

/**
 * 默认权限配置
 */
export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  dm: {
    defaultPolicy: 'allow',
    whitelist: [],
    blacklist: [],
    allowedTools: [],
    forbiddenTools: [],
  },
  group: {
    defaultPolicy: 'whitelist',
    whitelist: [],
    blacklist: [],
    allowedTools: [],
    forbiddenTools: [],
    allowMention: true,
    allowDirectCall: false,
    allowedUsers: [],
    rateLimitPerUser: 10,
    rateLimitWindowMs: 60000,
  },
  admins: [],
};

/**
 * 权限服务接口
 */
export interface PermissionService {
  /**
   * 检查消息权限
   *
   * @param message - 统一消息
   * @returns 权限检查结果
   */
  checkPermission(message: UnifiedMessage): Promise<PermissionCheckResult>;

  /**
   * 检查工具权限
   *
   * @param context - 消息上下文
   * @param toolName - 工具名称
   * @returns 权限检查结果
   */
  checkToolPermission(
    context: MessageContext,
    toolName: string,
  ): Promise<PermissionCheckResult>;

  /**
   * 检查是否为管理员
   *
   * @param userId - 用户 ID
   * @returns 是否为管理员
   */
  isAdmin(userId: string): boolean;

  /**
   * 更新权限配置
   *
   * @param config - 新的权限配置
   */
  updateConfig(config: Partial<PermissionConfig>): void;

  /**
   * 获取当前权限配置
   *
   * @returns 当前权限配置
   */
  getConfig(): PermissionConfig;
}

/**
 * 权限服务实现
 */
export class DefaultPermissionService implements PermissionService {
  private config: PermissionConfig;
  private messageTimestamps: Map<string, number[]> = new Map();

  constructor(config: Partial<PermissionConfig> = {}) {
    this.config = {
      dm: { ...DEFAULT_PERMISSION_CONFIG.dm },
      group: { ...DEFAULT_PERMISSION_CONFIG.group },
      admins: config.admins || [],
    };

    if (config.dm) {
      this.config.dm = { ...this.config.dm, ...config.dm };
    }
    if (config.group) {
      this.config.group = { ...this.config.group, ...config.group };
    }
  }

  async checkPermission(
    message: UnifiedMessage,
  ): Promise<PermissionCheckResult> {
    const { context } = message;

    if (this.isAdmin(context.userId)) {
      return { allowed: true };
    }

    if (context.userId === 'cron-system' || context.userId === 'system') {
      return { allowed: true };
    }

    if (context.groupId) {
      return this.checkGroupPermission(context);
    } else if (context.dmId) {
      return this.checkDMPermission(context);
    }

    return {
      allowed: false,
      reason: 'Unknown message context (neither DM nor group)',
    };
  }

  async checkToolPermission(
    context: MessageContext,
    toolName: string,
  ): Promise<PermissionCheckResult> {
    if (this.isAdmin(context.userId)) {
      return { allowed: true };
    }

    const config = context.groupId ? this.config.group : this.config.dm;

    if (context.groupId && toolName === 'shell') {
      return {
        allowed: false,
        reason: '群聊中禁止使用 shell 工具',
        suggestion: '仅管理员可在群聊中使用 shell',
      };
    }

    if (config.forbiddenTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `工具 "${toolName}" 已禁用`,
        suggestion: '请联系管理员启用',
      };
    }

    if (
      config.allowedTools.length > 0 &&
      !config.allowedTools.includes(toolName)
    ) {
      return {
        allowed: false,
        reason: `工具 "${toolName}" 不在允许列表中`,
        suggestion: '请使用允许的工具或联系管理员添加',
      };
    }

    return { allowed: true };
  }

  isAdmin(userId: string): boolean {
    return this.config.admins.includes(userId);
  }

  updateConfig(config: Partial<PermissionConfig>): void {
    if (config.dm) {
      this.config.dm = { ...this.config.dm, ...config.dm };
    }
    if (config.group) {
      this.config.group = { ...this.config.group, ...config.group };
    }
    if (config.admins) {
      this.config.admins = config.admins;
    }
  }

  getConfig(): PermissionConfig {
    return { ...this.config };
  }

  private checkGroupPermission(context: MessageContext): PermissionCheckResult {
    const { groupId, userId, metadata } = context;
    const config = this.config.group;

    if (!groupId) {
      return {
        allowed: false,
        reason: '群组 ID 缺失',
      };
    }

    if (this.isAdmin(userId)) {
      return { allowed: true };
    }

    if (config.allowedUsers.includes(userId)) {
      return { allowed: true };
    }

    if (config.blacklist.includes(groupId)) {
      return {
        allowed: false,
        reason: '此群组已被禁用',
        suggestion: '请联系管理员启用',
      };
    }

    if (
      config.defaultPolicy === 'whitelist' &&
      config.whitelist.length > 0 &&
      !config.whitelist.includes(groupId)
    ) {
      return {
        allowed: false,
        reason: '此群组不在白名单中',
        suggestion: '请联系管理员将群组加入白名单',
      };
    }

    const rateLimitResult = this.checkRateLimit(userId, groupId);
    if (!rateLimitResult.allowed) {
      return rateLimitResult;
    }

    if (!config.allowMention && metadata.mentioned === true) {
      return {
        allowed: false,
        reason: '此群组不允许 @ 机器人',
      };
    }

    if (!config.allowDirectCall && metadata.mentioned !== true) {
      return {
        allowed: false,
        reason: '此群组不允许直接调用机器人',
        suggestion: '请 @ 机器人来触发响应',
      };
    }

    return { allowed: true };
  }

  private checkRateLimit(
    userId: string,
    groupId: string,
  ): PermissionCheckResult {
    const config = this.config.group;

    if (config.rateLimitPerUser <= 0) {
      return { allowed: true };
    }

    const key = `${groupId}:${userId}`;
    const now = Date.now();
    const timestamps = this.messageTimestamps.get(key) || [];

    const windowStart = now - config.rateLimitWindowMs;
    const recentMessages = timestamps.filter((ts) => ts > windowStart);

    if (recentMessages.length >= config.rateLimitPerUser) {
      return {
        allowed: false,
        reason: '消息发送过于频繁，请稍后再试',
        suggestion: `每分钟最多发送 ${config.rateLimitPerUser} 条消息`,
      };
    }

    recentMessages.push(now);
    this.messageTimestamps.set(key, recentMessages);

    return { allowed: true };
  }

  private checkDMPermission(context: MessageContext): PermissionCheckResult {
    const { userId } = context;
    const config = this.config.dm;

    if (this.isAdmin(userId)) {
      return { allowed: true };
    }

    if (config.blacklist.includes(userId)) {
      return {
        allowed: false,
        reason: '此用户已被禁用',
        suggestion: '请联系管理员启用',
      };
    }

    if (config.defaultPolicy === 'deny') {
      return {
        allowed: false,
        reason: '私聊已被默认禁用',
        suggestion: '请联系管理员将你加入白名单',
      };
    }

    if (
      config.defaultPolicy === 'whitelist' &&
      !config.whitelist.includes(userId)
    ) {
      return {
        allowed: false,
        reason: '此用户不在白名单中',
        suggestion: '请联系管理员将你加入白名单',
      };
    }

    return { allowed: true };
  }
}

/**
 * 创建权限服务
 *
 * @param config - 权限配置（可选）
 * @returns 权限服务实例
 */
export function createPermissionService(
  config?: Partial<PermissionConfig>,
): PermissionService {
  return new DefaultPermissionService(config);
}

/**
 * 从环境变量创建权限服务
 *
 * @returns 权限服务实例
 */
export function createPermissionServiceFromEnv(): PermissionService {
  return new DefaultPermissionService({
    admins: process.env.ADMINS?.split(',').filter(Boolean) || [],
    group: {
      defaultPolicy: 'whitelist',
      whitelist:
        process.env.FEISHU_GROUP_WHITELIST?.split(',').filter(Boolean) || [],
      blacklist: [],
      allowedTools: [],
      forbiddenTools: [],
      allowMention: true,
      allowDirectCall: process.env.FEISHU_ALLOW_DIRECT_CALL === 'true',
      allowedUsers:
        process.env.FEISHU_GROUP_ALLOWED_USERS?.split(',').filter(Boolean) ||
        [],
      rateLimitPerUser: Number(process.env.FEISHU_GROUP_RATE_LIMIT) || 10,
      rateLimitWindowMs:
        Number(process.env.FEISHU_GROUP_RATE_LIMIT_WINDOW) || 60000,
    },
  });
}

/**
 * 从环境变量创建权限配置
 *
 * @returns 权限配置
 */
export function getPermissionConfigFromEnv(): PermissionConfig {
  return {
    dm: { ...DEFAULT_PERMISSION_CONFIG.dm },
    group: {
      ...DEFAULT_PERMISSION_CONFIG.group,
      whitelist:
        process.env.FEISHU_GROUP_WHITELIST?.split(',').filter(Boolean) || [],
      allowDirectCall: process.env.FEISHU_ALLOW_DIRECT_CALL === 'true',
      allowedUsers:
        process.env.FEISHU_GROUP_ALLOWED_USERS?.split(',').filter(Boolean) ||
        [],
      rateLimitPerUser: Number(process.env.FEISHU_GROUP_RATE_LIMIT) || 10,
      rateLimitWindowMs:
        Number(process.env.FEISHU_GROUP_RATE_LIMIT_WINDOW) || 60000,
    },
    admins: process.env.ADMINS?.split(',').filter(Boolean) || [],
  };
}
