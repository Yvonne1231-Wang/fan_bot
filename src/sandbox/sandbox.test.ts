import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SandboxServiceImpl,
  SandboxSecurityError,
  buildConfigFromEnv,
} from './service.js';
import { DEFAULT_SANDBOX_CONFIG } from './types.js';
import type { SandboxConfig } from './types.js';

describe('buildConfigFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it('should return default config when no env vars set', () => {
    delete process.env.SANDBOX_ENABLED;
    const config = buildConfigFromEnv();
    expect(config.enabled).toBe(false);
    expect(config.image).toBe(DEFAULT_SANDBOX_CONFIG.image);
    expect(config.network).toBe(DEFAULT_SANDBOX_CONFIG.network);
    expect(config.memoryMB).toBe(DEFAULT_SANDBOX_CONFIG.memoryMB);
  });

  it('should enable sandbox when SANDBOX_ENABLED=true', () => {
    process.env.SANDBOX_ENABLED = 'true';
    const config = buildConfigFromEnv();
    expect(config.enabled).toBe(true);
  });

  it('should not enable sandbox when SANDBOX_ENABLED=false', () => {
    process.env.SANDBOX_ENABLED = 'false';
    const config = buildConfigFromEnv();
    expect(config.enabled).toBe(false);
  });

  it('should override config with env vars', () => {
    process.env.SANDBOX_IMAGE = 'custom-image:v2';
    process.env.SANDBOX_NETWORK = 'bridge';
    process.env.SANDBOX_MEMORY_MB = '1024';
    const config = buildConfigFromEnv();
    expect(config.image).toBe('custom-image:v2');
    expect(config.network).toBe('bridge');
    expect(config.memoryMB).toBe(1024);
  });

  it('should apply overrides parameter', () => {
    const config = buildConfigFromEnv({ enabled: true, memoryMB: 2048 });
    expect(config.enabled).toBe(true);
    expect(config.memoryMB).toBe(2048);
  });

  it('should apply overrides when env var is not set', () => {
    delete process.env.SANDBOX_ENABLED;
    const config = buildConfigFromEnv({ enabled: true });
    expect(config.enabled).toBe(true);
  });

  it('should enable sandbox only when SANDBOX_ENABLED=true or override is true', () => {
    process.env.SANDBOX_ENABLED = 'false';
    const config = buildConfigFromEnv({ enabled: false });
    expect(config.enabled).toBe(false);
  });
});

describe('SandboxServiceImpl', () => {
  const disabledConfig: SandboxConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    enabled: false,
  };

  describe('isEnabled', () => {
    it('should return false when disabled', () => {
      const service = new SandboxServiceImpl(disabledConfig);
      expect(service.isEnabled()).toBe(false);
    });

    it('should return true when enabled', () => {
      const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, enabled: true };
      const service = new SandboxServiceImpl(config);
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('getConfig', () => {
    it('should return a copy of the config', () => {
      const service = new SandboxServiceImpl(disabledConfig);
      const config = service.getConfig();
      expect(config).toEqual(disabledConfig);
      expect(config).not.toBe(disabledConfig);
    });
  });

  describe('resolvePath', () => {
    let service: SandboxServiceImpl;

    beforeEach(() => {
      service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        workspacePath: '/workspace',
        projectPath: '/project',
        projectAccess: 'ro',
      });
    });

    it('should resolve relative path to workspace root when no session', () => {
      expect(service.resolvePath('data/test.json')).toBe(
        '/workspace/data/test.json',
      );
    });

    it('should resolve relative path to session workspace when session set', () => {
      service.setSessionContext({ sessionId: 'sess-abc' });
      expect(service.resolvePath('data/test.json')).toBe(
        '/workspace/sessions/sess-abc/data/test.json',
      );
    });

    it('should normalize path with ..', () => {
      expect(service.resolvePath('data/../tmp/file.txt')).toBe(
        '/workspace/tmp/file.txt',
      );
    });

    it('should normalize path with .. in session workspace', () => {
      service.setSessionContext({ sessionId: 'sess-abc' });
      expect(service.resolvePath('data/../tmp/file.txt')).toBe(
        '/workspace/sessions/sess-abc/tmp/file.txt',
      );
    });

    it('should allow absolute path within workspace', () => {
      expect(service.resolvePath('/workspace/data/file.txt')).toBe(
        '/workspace/data/file.txt',
      );
    });

    it('should allow absolute path within session workspace', () => {
      service.setSessionContext({ sessionId: 'sess-abc' });
      expect(service.resolvePath('/workspace/sessions/sess-abc/data/file.txt')).toBe(
        '/workspace/sessions/sess-abc/data/file.txt',
      );
    });

    it('should throw SandboxSecurityError for path escaping workspace', () => {
      expect(() => service.resolvePath('../../etc/passwd')).toThrow(
        SandboxSecurityError,
      );
      expect(() => service.resolvePath('/etc/passwd')).toThrow(
        SandboxSecurityError,
      );
    });

    it('should throw SandboxSecurityError for blocked path prefixes', () => {
      expect(() => service.resolvePath('/proc/self/environ')).toThrow(
        SandboxSecurityError,
      );
      expect(() => service.resolvePath('/sys/kernel')).toThrow(
        SandboxSecurityError,
      );
      expect(() => service.resolvePath('/dev/null')).toThrow(
        SandboxSecurityError,
      );
      expect(() => service.resolvePath('/root/.ssh')).toThrow(
        SandboxSecurityError,
      );
      expect(() => service.resolvePath('/home/user/.bashrc')).toThrow(
        SandboxSecurityError,
      );
    });

    it('should allow /project paths when projectAccess is not none', () => {
      expect(service.resolvePath('/project/src/index.ts')).toBe(
        '/project/src/index.ts',
      );
    });

    it('should reject /project paths when projectAccess is none', () => {
      const noProjectService = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        workspacePath: '/workspace',
        projectPath: '/project',
        projectAccess: 'none',
      });
      expect(() => noProjectService.resolvePath('/project/src/index.ts')).toThrow(
        SandboxSecurityError,
      );
    });
  });

  describe('setSessionContext / getSessionWorkspace', () => {
    it('should return workspace root when no session context', () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        workspacePath: '/workspace',
      });
      expect(service.getSessionWorkspace()).toBe('/workspace');
    });

    it('should return session workspace when session set', () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        workspacePath: '/workspace',
      });
      service.setSessionContext({ sessionId: 'sess-123' });
      expect(service.getSessionWorkspace()).toBe('/workspace/sessions/sess-123');
    });

    it('should reset session workspace when context cleared', () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        workspacePath: '/workspace',
      });
      service.setSessionContext({ sessionId: 'sess-123' });
      expect(service.getSessionWorkspace()).toBe('/workspace/sessions/sess-123');
      service.setSessionContext({});
      expect(service.getSessionWorkspace()).toBe('/workspace');
    });

    it('should switch session workspace when session changes', () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        workspacePath: '/workspace',
      });
      service.setSessionContext({ sessionId: 'sess-aaa' });
      expect(service.getSessionWorkspace()).toBe('/workspace/sessions/sess-aaa');
      service.setSessionContext({ sessionId: 'sess-bbb' });
      expect(service.getSessionWorkspace()).toBe('/workspace/sessions/sess-bbb');
    });
  });

  describe('isProjectPath', () => {
    it('should return true for paths under project directory', () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        projectPath: '/project',
        projectAccess: 'ro',
      });
      expect(service.isProjectPath('/project/src/index.ts')).toBe(true);
      expect(service.isProjectPath('/project/package.json')).toBe(true);
    });

    it('should return false for workspace paths', () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        workspacePath: '/workspace',
        projectPath: '/project',
        projectAccess: 'ro',
      });
      expect(service.isProjectPath('/workspace/data/test.txt')).toBe(false);
    });

    it('should return false when projectAccess is none', () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        projectPath: '/project',
        projectAccess: 'none',
      });
      expect(service.isProjectPath('/project/src/index.ts')).toBe(false);
    });
  });

  describe('init', () => {
    it('should skip initialization when disabled', async () => {
      const service = new SandboxServiceImpl(disabledConfig);
      await service.init();
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('execute / readFile / writeFile / listDir when disabled', () => {
    it('should throw error when calling execute on uninitialized sandbox', async () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        enabled: true,
      });
      await expect(service.execute('echo hello')).rejects.toThrow(
        'Sandbox is not initialized',
      );
    });

    it('should throw error when calling readFile on uninitialized sandbox', async () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        enabled: true,
      });
      await expect(service.readFile('/workspace/test.txt')).rejects.toThrow(
        'Sandbox is not initialized',
      );
    });

    it('should throw error when calling writeFile on uninitialized sandbox', async () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        enabled: true,
      });
      await expect(
        service.writeFile('/workspace/test.txt', 'content'),
      ).rejects.toThrow('Sandbox is not initialized');
    });

    it('should throw error when calling listDir on uninitialized sandbox', async () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        enabled: true,
      });
      await expect(service.listDir('/workspace')).rejects.toThrow(
        'Sandbox is not initialized',
      );
    });
  });

  describe('healthCheck', () => {
    it('should return false when disabled', async () => {
      const service = new SandboxServiceImpl(disabledConfig);
      expect(await service.healthCheck()).toBe(false);
    });

    it('should return false when enabled but not initialized', async () => {
      const service = new SandboxServiceImpl({
        ...DEFAULT_SANDBOX_CONFIG,
        enabled: true,
      });
      expect(await service.healthCheck()).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should not throw when called on uninitialized sandbox', async () => {
      const service = new SandboxServiceImpl(disabledConfig);
      await expect(service.destroy()).resolves.toBeUndefined();
    });
  });
});

describe('SandboxSecurityError', () => {
  it('should have correct name property', () => {
    const error = new SandboxSecurityError('test error');
    expect(error.name).toBe('SandboxSecurityError');
    expect(error.message).toBe('test error');
    expect(error).toBeInstanceOf(Error);
  });
});
