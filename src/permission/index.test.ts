import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPermissionService,
  DefaultPermissionService,
  DEFAULT_PERMISSION_CONFIG,
  type PermissionConfig,
} from '../permission/index.js';
import type { UnifiedMessage } from '../transport/unified.js';

/**
 * 创建测试用的统一消息
 */
function createTestMessage(
  userId: string,
  groupId?: string,
  dmId?: string,
): UnifiedMessage {
  return {
    id: `test-msg-${Date.now()}`,
    context: {
      channel: 'cli',
      userId,
      sessionId: 'test-session',
      groupId,
      dmId,
      metadata: {},
    },
    content: [{ type: 'text', text: 'test message' }],
    timestamp: Date.now(),
  };
}

describe('PermissionService', () => {
  let permissionService: DefaultPermissionService;

  beforeEach(() => {
    permissionService = new DefaultPermissionService();
  });

  describe('default configuration', () => {
    it('should allow DM messages by default', async () => {
      const message = createTestMessage('user-1', undefined, 'dm-1');
      const result = await permissionService.checkPermission(message);
      expect(result.allowed).toBe(true);
    });

    it('should deny group messages by default (whitelist policy)', async () => {
      const message = createTestMessage('user-1', 'group-1', undefined);
      const result = await permissionService.checkPermission(message);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in whitelist');
    });
  });

  describe('admin privileges', () => {
    it('should allow all actions for admin users', async () => {
      const adminService = new DefaultPermissionService({
        admins: ['admin-1'],
      });

      const groupMessage = createTestMessage('admin-1', 'group-1', undefined);
      const result = await adminService.checkPermission(groupMessage);
      expect(result.allowed).toBe(true);
    });

    it('should allow admin to use any tool', async () => {
      const adminService = new DefaultPermissionService({
        admins: ['admin-1'],
      });

      const context = {
        channel: 'cli' as const,
        userId: 'admin-1',
        sessionId: 'test-session',
        metadata: {},
      };

      const result = await adminService.checkToolPermission(
        context,
        'dangerous-tool',
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('group permissions', () => {
    it('should allow messages from whitelisted groups when mentioned', async () => {
      const service = new DefaultPermissionService({
        group: {
          ...DEFAULT_PERMISSION_CONFIG.group,
          whitelist: ['allowed-group'],
          defaultPolicy: 'whitelist',
          allowMention: true,
          allowDirectCall: false,
        },
      });

      const message = createTestMessage('user-1', 'allowed-group', undefined);
      message.context.metadata.mentioned = true;
      const result = await service.checkPermission(message);
      expect(result.allowed).toBe(true);
    });

    it('should allow direct calls when allowDirectCall is true', async () => {
      const service = new DefaultPermissionService({
        group: {
          ...DEFAULT_PERMISSION_CONFIG.group,
          whitelist: ['allowed-group'],
          defaultPolicy: 'whitelist',
          allowMention: true,
          allowDirectCall: true,
        },
      });

      const message = createTestMessage('user-1', 'allowed-group', undefined);
      const result = await service.checkPermission(message);
      expect(result.allowed).toBe(true);
    });

    it('should deny messages from blacklisted groups', async () => {
      const service = new DefaultPermissionService({
        group: {
          ...DEFAULT_PERMISSION_CONFIG.group,
          blacklist: ['blocked-group'],
          defaultPolicy: 'allow',
        },
      });

      const message = createTestMessage('user-1', 'blocked-group', undefined);
      const result = await service.checkPermission(message);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blacklisted');
    });

    it('should require mention when allowDirectCall is false', async () => {
      const service = new DefaultPermissionService({
        group: {
          ...DEFAULT_PERMISSION_CONFIG.group,
          whitelist: ['test-group'],
          defaultPolicy: 'whitelist',
          allowMention: true,
          allowDirectCall: false,
        },
      });

      const message = createTestMessage('user-1', 'test-group', undefined);
      const result = await service.checkPermission(message);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Direct call');
    });

    it('should allow messages when user is mentioned', async () => {
      const service = new DefaultPermissionService({
        group: {
          ...DEFAULT_PERMISSION_CONFIG.group,
          whitelist: ['test-group'],
          defaultPolicy: 'whitelist',
          allowMention: true,
          allowDirectCall: false,
        },
      });

      const message = createTestMessage('user-1', 'test-group', undefined);
      message.context.metadata.mentioned = true;
      const result = await service.checkPermission(message);
      expect(result.allowed).toBe(true);
    });
  });

  describe('DM permissions', () => {
    it('should deny messages from blacklisted users', async () => {
      const service = new DefaultPermissionService({
        dm: {
          ...DEFAULT_PERMISSION_CONFIG.dm,
          blacklist: ['blocked-user'],
        },
      });

      const message = createTestMessage('blocked-user', undefined, 'dm-1');
      const result = await service.checkPermission(message);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blacklisted');
    });

    it('should allow only whitelisted users when policy is whitelist', async () => {
      const service = new DefaultPermissionService({
        dm: {
          ...DEFAULT_PERMISSION_CONFIG.dm,
          whitelist: ['allowed-user'],
          defaultPolicy: 'whitelist',
        },
      });

      const allowedMessage = createTestMessage(
        'allowed-user',
        undefined,
        'dm-1',
      );
      const allowedResult = await service.checkPermission(allowedMessage);
      expect(allowedResult.allowed).toBe(true);

      const deniedMessage = createTestMessage('other-user', undefined, 'dm-2');
      const deniedResult = await service.checkPermission(deniedMessage);
      expect(deniedResult.allowed).toBe(false);
    });
  });

  describe('tool permissions', () => {
    it('should deny forbidden tools', async () => {
      const service = new DefaultPermissionService({
        dm: {
          ...DEFAULT_PERMISSION_CONFIG.dm,
          forbiddenTools: ['dangerous-tool'],
        },
      });

      const context = {
        channel: 'cli' as const,
        userId: 'user-1',
        sessionId: 'test-session',
        dmId: 'dm-1',
        metadata: {},
      };

      const result = await service.checkToolPermission(
        context,
        'dangerous-tool',
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('forbidden');
    });

    it('should allow only whitelisted tools when allowedTools is set', async () => {
      const service = new DefaultPermissionService({
        dm: {
          ...DEFAULT_PERMISSION_CONFIG.dm,
          allowedTools: ['safe-tool'],
        },
      });

      const context = {
        channel: 'cli' as const,
        userId: 'user-1',
        sessionId: 'test-session',
        dmId: 'dm-1',
        metadata: {},
      };

      const allowedResult = await service.checkToolPermission(
        context,
        'safe-tool',
      );
      expect(allowedResult.allowed).toBe(true);

      const deniedResult = await service.checkToolPermission(
        context,
        'other-tool',
      );
      expect(deniedResult.allowed).toBe(false);
    });
  });

  describe('configuration management', () => {
    it('should update configuration', () => {
      const service = new DefaultPermissionService();
      service.updateConfig({
        admins: ['new-admin'],
      });

      expect(service.isAdmin('new-admin')).toBe(true);
    });

    it('should return current configuration', () => {
      const config: Partial<PermissionConfig> = {
        admins: ['admin-1'],
      };
      const service = new DefaultPermissionService(config);
      const currentConfig = service.getConfig();

      expect(currentConfig.admins).toContain('admin-1');
    });
  });
});

describe('createPermissionService', () => {
  it('should create a permission service instance', () => {
    const service = createPermissionService();
    expect(service).toBeInstanceOf(DefaultPermissionService);
  });

  it('should create service with custom config', () => {
    const service = createPermissionService({
      admins: ['admin-1'],
    });

    expect(service.isAdmin('admin-1')).toBe(true);
  });
});
