/**
 * Agent Team Smoke Test
 *
 * 测试重构后的 Agent Team 功能
 */

import { config } from 'dotenv';
config();

import { createLLMClient, Provider } from '../../llm/index.js';
import {
  AgentTeam,
  TaskAnalyzer,
  TaskRouter,
  CODER_PROMPT,
  RESEARCHER_PROMPT,
  createCoderToolRegistry,
  createResearcherToolRegistry,
} from './index.js';
import type { TeamAgent, TeamConfig, TeamTask } from './types.js';
import { getErrorMessage } from '../../utils/error.js';

/**
 * 运行 Agent Team 测试
 */
async function runTeamSmokeTest(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  Agent Team Smoke Test (重构版)');
  console.log('='.repeat(60));
  console.log('');

  const apiKey = process.env.ARK_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(
      'No API key found. Set ARK_API_KEY or ANTHROPIC_API_KEY to run tests.',
    );
    console.log('Skipping smoke tests.\n');
    return;
  }

  const useArk = !!process.env.ARK_API_KEY;
  const llmClient = createLLMClient({
    provider: useArk ? Provider.Ark : Provider.Anthropic,
    apiKey,
    baseURL: useArk ? process.env.ARK_BASE_URL : undefined,
    model: useArk ? process.env.ARK_MODEL : process.env.ANTHROPIC_MODEL,
  });
  console.log(`✓ LLM client created (${useArk ? 'ark' : 'anthropic'})\n`);

  const analyzer = new TaskAnalyzer();
  const router = new TaskRouter();

  await testTaskAnalysis(analyzer);
  await testTaskRouting(analyzer, router);
  await testTeamExecution(llmClient);

  console.log('\n✅ All Agent Team tests passed!\n');
}

/**
 * 测试任务分析能力
 */
async function testTaskAnalysis(analyzer: TaskAnalyzer): Promise<void> {
  console.log('─'.repeat(60));
  console.log('Test 1: Task Analysis (任务分析)');
  console.log('─'.repeat(60));

  const testCases = [
    { prompt: '写一个函数计算斐波那契数列', expected: 'simple' },
    {
      prompt: '分析这段代码的性能问题，然后优化它，并编写测试用例',
      expected: 'complex',
    },
    { prompt: '帮我搜索一下最新的 AI 新闻，然后写一份总结报告', expected: 'complex' },
  ];

  for (const { prompt, expected } of testCases) {
    console.log(`\n任务: "${prompt}"`);
    const analysis = await analyzer.analyzeTask(prompt);
    console.log(`  复杂度: ${analysis.complexity}`);
    console.log(`  所需能力: ${analysis.requiredAbilities.join(', ') || '无'}`);
    console.log(`  估计步骤: ${analysis.estimatedSteps}`);
    console.log(`  建议团队: ${analysis.recommendTeam ? '是' : '否'}`);

    if (expected === 'complex' && !analysis.recommendTeam) {
      console.log(`  ⚠️  预期建议使用团队，但结果为否`);
    } else {
      console.log(`  ✓ 分析正确`);
    }
  }
}

/**
 * 测试任务路由能力
 */
async function testTaskRouting(
  analyzer: TaskAnalyzer,
  router: TaskRouter,
): Promise<void> {
  console.log('\n' + '─'.repeat(60));
  console.log('Test 2: Task Routing (任务路由)');
  console.log('─'.repeat(60));

  const testCases = [
    { prompt: '你好', expectedRoute: 'single' },
    { prompt: '分析代码并优化性能', expectedRoute: 'team' },
    { prompt: '帮我写一个简单的 hello world 程序', expectedRoute: 'single' },
  ];

  for (const { prompt, expectedRoute } of testCases) {
    console.log(`\n任务: "${prompt}"`);
    const analysis = await analyzer.analyzeTask(prompt);
    const route = await router.determineRoute(analysis);
    console.log(`  路由结果: ${route === 'team' ? '团队协作' : '单 Agent'}`);

    if (route === expectedRoute) {
      console.log(`  ✓ 路由正确`);
    } else {
      console.log(`  ⚠️  预期 ${expectedRoute}，实际 ${route}`);
    }
  }
}

/**
 * 测试团队执行能力
 */
async function testTeamExecution(
  llmClient: ReturnType<typeof createLLMClient>,
): Promise<void> {
  console.log('\n' + '─'.repeat(60));
  console.log('Test 3: Team Execution (团队执行)');
  console.log('─'.repeat(60));

  const coderAgent: TeamAgent = {
    type: 'coder',
    name: '程序员',
    abilities: ['coding', 'code_analysis', 'code_generation'],
    tools: [],
    systemPrompt: CODER_PROMPT,
    toolRegistry: createCoderToolRegistry(),
  };

  const researcherAgent: TeamAgent = {
    type: 'researcher',
    name: '研究员',
    abilities: ['research', 'analysis', 'information_search'],
    tools: [],
    systemPrompt: RESEARCHER_PROMPT,
    toolRegistry: createResearcherToolRegistry(),
  };

  const coordinator: TeamAgent = {
    type: 'coordinator',
    name: '协调者',
    abilities: ['task_planning', 'task_assignment', 'coordination'],
    tools: [],
    systemPrompt: '你是一个团队协调者，负责任务分配和结果整合。',
    toolRegistry: createCoderToolRegistry(),
  };

  const teamConfig: TeamConfig = {
    enableTeam: true,
    coordinator,
    teammates: [coderAgent, researcherAgent],
    llmClient,
    workDir: './workspaces/team',
  };

  const team = new AgentTeam(teamConfig);
  console.log('\n✓ 团队创建成功');
  console.log(`  协调者: ${coordinator.name}`);
  console.log(`  成员: ${teamConfig.teammates?.map((a: TeamAgent) => a.name).join(', ')}`);

  const prompt = '写一个简单的 TypeScript 函数，计算两个数的和';
  console.log(`\n执行任务: "${prompt}"`);

  try {
    console.log('\n[1] 规划任务...');
    const tasks = await team.planTask(prompt);
    console.log(`  生成 ${tasks.length} 个子任务:`);
    for (const task of tasks) {
      const assigneeName = task.assignee?.name ?? '未分配';
      console.log(`    - [${assigneeName}] ${task.description.slice(0, 40)}...`);
    }

    console.log('\n[2] 执行任务...');
    const results: Array<{ task: TeamTask; result: unknown }> = [];
    for (const task of tasks) {
      const assigneeName = task.assignee?.name ?? 'Agent';
      console.log(`  执行 [${assigneeName}]: ${task.description.slice(0, 40)}...`);
      const result = await team.executeTask(task);
      results.push({ task, result });
    }

    console.log('\n[3] 整合结果...');
    const finalResult = await team.synthesizeResults(tasks);
    console.log('\n' + '─'.repeat(40));
    console.log('最终结果:');
    console.log('─'.repeat(40));
    console.log(
      finalResult.slice(0, 500) + (finalResult.length > 500 ? '...' : ''),
    );
    console.log('─'.repeat(40));

    console.log('\n✓ 团队执行测试通过');
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.log(`\n⚠️  执行出错: ${errorMessage}`);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTeamSmokeTest().catch((error) => {
    console.error('\n❌ Smoke test failed:', error);
    process.exit(1);
  });
}

export { runTeamSmokeTest };
