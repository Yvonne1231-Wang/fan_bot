import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMediaUnderstanding } from './runner.js';
import { readCache, writeCache } from './cache.js';

describe('runMediaUnderstanding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('无附件时立即返回，零开销', async () => {
    const ctx = { Body: 'hello' };
    const result = await runMediaUnderstanding(ctx, {});
    expect(result.outputs).toHaveLength(0);
    expect(result.decisions).toHaveLength(0);
  });

  it('无 MediaPaths 时直接返回', async () => {
    const ctx = { Body: 'hello', MediaUrls: [] };
    const result = await runMediaUnderstanding(ctx, {});
    expect(result.outputs).toHaveLength(0);
    expect(result.decisions).toHaveLength(0);
  });

  it('能力被禁用时跳过', async () => {
    const ctx = { MediaPaths: ['/tmp/test.png'], MediaTypes: ['image/png'] };
    const result = await runMediaUnderstanding(ctx, {
      image: { enabled: false },
    });
    expect(result.outputs).toHaveLength(0);
    expect(result.decisions).toHaveLength(0);
  });

  it('scope 为 disabled 时跳过', async () => {
    const ctx = {
      MediaPaths: ['/tmp/test.png'],
      MediaTypes: ['image/png'],
      ChatType: 'direct' as const,
    };
    const result = await runMediaUnderstanding(ctx, {
      image: { enabled: true },
      scope: { image: 'disabled' },
    });
    expect(result.outputs).toHaveLength(0);
  });

  it('scope 为 dm 但消息来自群组时跳过', async () => {
    const ctx = {
      MediaPaths: ['/tmp/test.png'],
      MediaTypes: ['image/png'],
      ChatType: 'group' as const,
    };
    const result = await runMediaUnderstanding(ctx, {
      image: { enabled: true },
      scope: { image: 'dm' },
    });
    expect(result.outputs).toHaveLength(0);
  });

  it('scope 为 paired 但用户未配对时跳过', async () => {
    const ctx = {
      MediaPaths: ['/tmp/test.png'],
      MediaTypes: ['image/png'],
      ChatType: 'direct' as const,
      IsPaired: false,
    };
    const result = await runMediaUnderstanding(ctx, {
      image: { enabled: true },
      scope: { image: 'paired' },
    });
    expect(result.outputs).toHaveLength(0);
  });
});

describe('cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('readCache 在缓存未命中时返回 null', async () => {
    const result = await readCache('nonexistent-key', {
      enabled: true,
      ttlDays: 30,
    });
    expect(result).toBeNull();
  });

  it('readCache 在缓存禁用时返回 null', async () => {
    const result = await readCache('any-key', { enabled: false });
    expect(result).toBeNull();
  });
});
