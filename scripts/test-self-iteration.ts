/**
 * 自迭代能力 E2E Demo 测试
 *
 * 用法：DRY_RUN=true npx tsx scripts/test-self-iteration.ts
 */

import { createSelfIteration } from '../src/self-iteration/index.js';
import type { CodeChangeRequest } from '../src/self-iteration/index.js';

const WORK_DIR = process.cwd();
const TEST_FILE = 'src/utils/self-iteration-demo.ts';

process.env.DRY_RUN = 'true';

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('  自迭代能力 E2E Demo 测试');
  console.log('═══════════════════════════════════════════\n');

  // Step 1: 初始化
  console.log('📦 Step 1: 初始化自迭代系统...');
  const si = createSelfIteration({
    workDir: WORK_DIR,
    mainBranch: 'feat/self-iteration',
    skipSandbox: true,
  });
  await si.initialize();
  console.log('   ✅ 初始化完成\n');

  // Step 2: 构建请求
  console.log('📝 Step 2: 提交代码新增请求...');
  const request: CodeChangeRequest = {
    intent: 'add',
    targetFile: TEST_FILE,
    description: 'demo: add self-iteration test marker file',
    operator: {
      type: 'user',
      userId: 'test-demo',
      userName: 'E2E-Demo',
    },
    rawMessage: '测试自迭代能力 - 新增一个标记文件',
  };

  const testFileContent = [
    '// Self-Iteration Demo Marker',
    '// Auto-created: ' + new Date().toISOString(),
    '',
    'export const SELF_ITERATION_DEMO = {',
    '  createdAt: "' + new Date().toISOString() + '",',
    '  purpose: "verify self-iteration e2e pipeline",',
    '  version: 1,',
    '} as const;',
    '',
    'export type SelfIterationDemo = typeof SELF_ITERATION_DEMO;',
    '',
  ].join('\n');

  console.log('   目标文件: ' + TEST_FILE);
  console.log('   开始执行...\n');

  // Step 3: 执行
  const startTime = Date.now();
  const result = await si.modify(request, [{ filePath: TEST_FILE, content: testFileContent }]);

  // Step 4: 结果
  console.log('═══════════════════════════════════════════');
  console.log('  执行结果');
  console.log('═══════════════════════════════════════════\n');

  if (result.success) {
    console.log('🎉 SUCCESS!');
    console.log('   分支:   ' + result.branch);
    console.log('   Commit: ' + result.commitHash.slice(0, 8));
    console.log('   Tag:    ' + result.tag);
    console.log('   耗时:   ' + (Date.now() - startTime) + 'ms');
    if (result.validationResults) {
      const v = result.validationResults;
      console.log('   验证:   tsc=' + (v.tscPass ? '✓' : '✗') + ' test=' + (v.testPass ? '✓' : '✗') + ' sandbox=' + (v.sandboxPass ? '✓' : '✗'));
    }
  } else {
    console.log('❌ FAILED');
    console.log('   错误: ' + result.error);
    console.log('   耗时: ' + (Date.now() - startTime) + 'ms');
    if (result.validationResults) {
      const v = result.validationResults;
      console.log('   验证:   tsc=' + (v.tscPass ? '✓' : '✗') + ' test=' + (v.testPass ? '✓' : '✗') + ' sandbox=' + (v.sandboxPass ? '✓' : '✗'));
    }
  }

  // Step 5: 审计日志
  console.log('\n📋 审计日志:');
  console.log(si.formatAuditLogs(3));

  // Step 6: 清理测试文件
  console.log('\n🧹 清理测试文件...');
  try {
    const { unlinkSync, existsSync } = await import('fs');
    const fullPath = WORK_DIR + '/' + TEST_FILE;
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
      console.log('   ✅ 测试文件已删除');
    } else {
      console.log('   ⚠️  文件不存在，跳过');
    }
  } catch (e) {
    console.log('   ⚠️  ' + (e as Error).message);
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  Demo 完成! ' + (result.success ? '🎉' : '💥'));
  console.log('═══════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('💥 异常:', err);
  process.exit(1);
});
