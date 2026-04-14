import { describe, it, expect } from 'vitest';
import { createMemoryService, DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './factory.js';

describe('createMemoryService', () => {
  it('should create LanceDB service with default config', async () => {
    const service = await createMemoryService(DEFAULT_MEMORY_CONFIG);
    expect(service).toBeDefined();
    expect(service.setUserId).toBeTypeOf('function');
    expect(service.search).toBeTypeOf('function');
    expect(service.remember).toBeTypeOf('function');
  });

  it('should create JSON memory service', async () => {
    const config: MemoryConfig = {
      backend: 'json',
      json: { dir: '/tmp/test-memory-factory' },
    };
    const service = await createMemoryService(config);
    expect(service).toBeDefined();
    expect(service.setUserId).toBeTypeOf('function');
    expect(service.search).toBeTypeOf('function');
  });

  it('should throw for unknown backend', async () => {
    const config = { backend: 'unknown' as 'lancedb' };
    await expect(createMemoryService(config)).rejects.toThrow('Unknown memory backend');
  });
});
