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

    if (config.forbiddenTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" is forbidden`,
        suggestion: 'Contact admin to enable this tool',
      };
    }

    if (
      config.allowedTools.length > 0 &&
      !config.allowedTools.includes(toolName)
    ) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" is not in allowed list`,
        suggestion: 'Use one of the allowed tools or ask admin to add it',
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
        reason: 'Group ID is missing',
      };
    }

    if (config.blacklist.includes(groupId)) {
      return {
        allowed: false,
        reason: 'This group is blacklisted',
        suggestion: 'Contact admin to remove from blacklist',
      };
    }

    if (config.defaultPolicy === 'deny') {
      return {
        allowed: false,
        reason: 'Group messages are denied by default',
        suggestion: 'Add this group to whitelist or change default policy',
      };
    }

    if (
      config.defaultPolicy === 'whitelist' &&
      !config.whitelist.includes(groupId)
    ) {
      return {
        allowed: false,
        reason: 'This group is not in whitelist',
        suggestion: 'Add this group to whitelist or change default policy',
      };
    }

    const isMentioned = metadata.mentioned === true;

    if (!config.allowMention && isMentioned) {
      return {
        allowed: false,
        reason: 'Mentioning the bot is not allowed in this group',
      };
    }

    if (!config.allowDirectCall && !isMentioned) {
      return {
        allowed: false,
        reason: 'Direct call (without mention) is not allowed in this group',
        suggestion: 'Mention the bot to trigger a response',
      };
    }

    return { allowed: true };
  }

  private checkDMPermission(context: MessageContext): PermissionCheckResult {
    const { userId } = context;
    const config = this.config.dm;

    if (config.blacklist.includes(userId)) {
      return {
        allowed: false,
        reason: 'This user is blacklisted',
        suggestion: 'Contact admin to remove from blacklist',
      };
    }

    if (config.defaultPolicy === 'deny') {
      return {
        allowed: false,
        reason: 'DM messages are denied by default',
        suggestion: 'Add this user to whitelist or change default policy',
      };
    }

    if (
      config.defaultPolicy === 'whitelist' &&
      !config.whitelist.includes(userId)
    ) {
      return {
        allowed: false,
        reason: 'This user is not in whitelist',
        suggestion: 'Add this user to whitelist or change default policy',
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
    },
    admins: process.env.ADMINS?.split(',').filter(Boolean) || [],
  };
}
