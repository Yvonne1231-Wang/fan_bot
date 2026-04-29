// ─── Validator Tests ────────────────────────────────────────────────────────
// 注意：验证器的测试需要真实的项目环境（npm run typecheck, npm test 等）
// 这里只测试基本构造和配置

import { describe, it, expect } from 'vitest';
import { CodeValidator } from '../validator.js';

describe('CodeValidator', () => {
  it('应该使用默认配置创建实例', () => {
    const validator = new CodeValidator({ workDir: '/tmp/fake' });
    expect(validator).toBeDefined();
  });

  it('应该支持自定义配置', () => {
    const validator = new CodeValidator({
      workDir: '/tmp/fake',
      testTimeout: 120_000,
      sandboxTimeout: 30_000,
      readySignals: ['READY'],
      skipSandbox: true,
    });
    expect(validator).toBeDefined();
  });

  // 完整的 validate() 测试需要在真实项目中运行
  // 以下是集成测试级别的，标记为 skip
  it.skip('应该在真实项目中通过验证三关', async () => {
    const validator = new CodeValidator({
      workDir: process.cwd(),
      skipSandbox: true,
    });
    const results = await validator.validate();
    expect(results.tscPass).toBe(true);
    expect(results.testPass).toBe(true);
  });
});
