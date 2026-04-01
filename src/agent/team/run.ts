/**
 * Agent Team 任务执行器
 *
 * V4 版本：
 * - Phase 1-5 完整流程
 * - DAG 关系图可视化
 * - 实时状态显示
 * - 输出文件位置追踪
 *
 * 使用方法:
 *   npx tsx src/agent/team/run.ts "你的任务描述"
 */

import { config } from 'dotenv';
config();

import { createLLMClient, Provider } from '../../llm/index.js';
import { AgentTeam } from './agent.js';
import type { TeamConfig, ProgressEvent, TeamTask } from './types.js';

/**
 * 显示 DAG 关系图
 */
function displayDAG(tasks: TeamTask[]): void {
  console.log('\n📊 任务依赖关系 (DAG):');
  console.log('─'.repeat(50));

  if (tasks.length === 0) {
    console.log('  无任务');
    console.log('─'.repeat(50));
    return;
  }

  const taskMap = new Map<string, TeamTask>();
  tasks.forEach((t) => taskMap.set(t.id, t));

  // 找出无依赖的任务（入口节点）
  const entryTasks = tasks.filter(
    (t) => !t.dependencies || t.dependencies.length === 0,
  );

  // 已绘制的任务（避免重复）
  const drawn = new Set<string>();

  // 绘制 DAG
  function drawTask(task: TeamTask, indent: string, isLast: boolean): void {
    // 如果已经绘制过，显示引用
    if (drawn.has(task.id)) {
      const prefix = isLast ? '└── ' : '├── ';
      const assignee = task.assignee?.name || '未分配';
      console.log(`${indent}${prefix}↪ [${assignee}] (已绘制)`);
      return;
    }
    drawn.add(task.id);

    const prefix = isLast ? '└── ' : '├── ';
    const assignee = task.assignee?.name || '未分配';
    const statusIcon = getStatusIcon(task.status);

    console.log(
      `${indent}${prefix}${statusIcon} [${assignee}] ${task.description.slice(0, 35)}...`,
    );

    // 找出依赖此任务的任务
    const dependents = tasks.filter((t) => t.dependencies?.includes(task.id));

    const newIndent = indent + (isLast ? '    ' : '│   ');
    dependents.forEach((dep, idx) => {
      drawTask(dep, newIndent, idx === dependents.length - 1);
    });
  }

  // 从入口节点开始绘制
  if (entryTasks.length === 0 && tasks.length > 0) {
    // 如果没有入口节点（可能存在循环依赖），显示所有任务
    console.log('  ⚠️ 检测到可能的循环依赖，显示所有任务:');
    tasks.forEach((task, idx) => {
      const assignee = task.assignee?.name || '未分配';
      const statusIcon = getStatusIcon(task.status);
      console.log(
        `  ${statusIcon} [${assignee}] ${task.description.slice(0, 40)}...`,
      );
    });
  } else {
    entryTasks.forEach((task, idx) => {
      drawTask(task, '', idx === entryTasks.length - 1);
    });
  }

  console.log('─'.repeat(50));
}

/**
 * 获取状态图标
 */
function getStatusIcon(status: string): string {
  switch (status) {
    case 'pending':
      return '⏳';
    case 'in_progress':
      return '🔄';
    case 'completed':
      return '✅';
    case 'error':
      return '❌';
    default:
      return '❓';
  }
}

/**
 * 显示 Agent 状态面板
 */
function displayAgentPanel(
  agents: Array<{ type: string; name: string; isLead?: boolean }>,
  taskStatus: Map<string, { agent: string; status: string; task: string }>,
): void {
  console.log('\n👥 Agent 状态面板:');
  console.log('─'.repeat(50));

  agents.forEach((agent) => {
    const leadTag = agent.isLead ? ' 👑' : '';
    const agentTasks = Array.from(taskStatus.values()).filter(
      (t) => t.agent === agent.name,
    );

    if (agentTasks.length === 0) {
      console.log(`  ${agent.name}${leadTag}: 空闲`);
    } else {
      const statusList = agentTasks
        .map((t) => `${getStatusIcon(t.status)} ${t.task.slice(0, 30)}...`)
        .join('\n    ');
      console.log(`  ${agent.name}${leadTag}:\n    ${statusList}`);
    }
  });

  console.log('─'.repeat(50));
}

/**
 * 显示输出位置
 */
function displayOutputLocations(
  outputs: Array<{
    agent: string;
    type: string;
    content: string;
    location?: string;
  }>,
): void {
  if (outputs.length === 0) return;

  console.log('\n📁 输出位置:');
  console.log('─'.repeat(50));

  outputs.forEach((output) => {
    if (output.location) {
      console.log(`  📄 [${output.agent}] ${output.location}`);
    } else if (output.type === 'code') {
      console.log(`  💻 [${output.agent}] 代码输出 (见上方结果)`);
    } else if (output.type === 'document') {
      console.log(`  📝 [${output.agent}] 文档输出 (见上方结果)`);
    }
  });

  console.log('─'.repeat(50));
}

/**
 * 从结果中提取输出位置
 */
function extractOutputLocations(
  results: Array<{
    agentType: string;
    output: string;
    toolCalls?: Array<{ tool: string; input: unknown; output: string }>;
  }>,
): Array<{ agent: string; type: string; content: string; location?: string }> {
  const outputs: Array<{
    agent: string;
    type: string;
    content: string;
    location?: string;
  }> = [];

  results.forEach((result) => {
    // 检查工具调用中的文件写入
    result.toolCalls?.forEach((tc) => {
      if (tc.tool === 'write_file' || tc.tool === 'writeFile') {
        try {
          const input = tc.input as
            | { path?: string; content?: string }
            | undefined;
          if (input?.path) {
            outputs.push({
              agent: result.agentType,
              type: 'file',
              content: input.content || '',
              location: input.path,
            });
          }
        } catch {
          // ignore
        }
      }
    });

    // 检查输出内容中的文件路径
    const filePathMatch = result.output.match(
      /(?:文件|file|path)[:：]?\s*([^\n]+\.(ts|js|py|md|txt|json))/i,
    );
    if (filePathMatch) {
      outputs.push({
        agent: result.agentType,
        type: 'file',
        content: result.output,
        location: filePathMatch[1].trim(),
      });
    }
  });

  return outputs;
}

async function run(): Promise<void> {
  const prompt = process.argv.slice(2).join(' ');

  if (!prompt) {
    console.log('用法: npx tsx src/agent/team/run.ts "任务描述"');
    console.log('');
    console.log('示例:');
    console.log('  npx tsx src/agent/team/run.ts "帮我写一个冒泡排序算法"');
    console.log('  npx tsx src/agent/team/run.ts "分析代码性能并优化"');
    console.log('  npx tsx src/agent/team/run.ts "搜索 AI 最新进展并写报告"');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log(`  🎯 任务: ${prompt}`);
  console.log('='.repeat(60));

  const apiKey = process.env.ARK_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('请设置 ARK_API_KEY 或 ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const useArk = !!process.env.ARK_API_KEY;
  const llmClient = createLLMClient({
    provider: useArk ? Provider.Ark : Provider.Anthropic,
    apiKey,
    baseURL: useArk ? process.env.ARK_BASE_URL : undefined,
    model: useArk ? process.env.ARK_MODEL : process.env.ANTHROPIC_MODEL,
  });

  const teamConfig: TeamConfig = {
    enableTeam: true,
    llmClient,
    workDir: './workspaces/team',
    concurrency: 3,
  };

  const team = new AgentTeam(teamConfig);

  console.log('\n📋 可用 Agent 类型:');
  const agentTypes = AgentTeam.getAvailableAgentTypes();
  for (const agent of agentTypes) {
    console.log(`  • ${agent.name}: ${agent.description}`);
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 1-3: Plan, Spawn, Create
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('📌 Phase 1-3: Plan, Spawn, Create');
  console.log('═'.repeat(60));

  const tasks = await team.planTask(prompt);
  const agents = team.getAgents();

  // 显示创建的 Agent
  console.log('\n🤖 动态创建的 Agent:');
  agents.forEach((agent) => {
    const leadTag = agent.isLead ? ' 👑 (Lead)' : '';
    console.log(`  • ${agent.name}${leadTag}`);
    console.log(`    能力: ${agent.abilities.slice(0, 3).join(', ')}`);
  });

  // 显示 DAG 关系图
  displayDAG(tasks);

  // 任务状态追踪
  const taskStatus = new Map<
    string,
    { agent: string; status: string; task: string }
  >();
  tasks.forEach((t) => {
    taskStatus.set(t.id, {
      agent: t.assignee?.name || '未分配',
      status: t.status,
      task: t.description,
    });
  });

  // 显示初始 Agent 状态
  displayAgentPanel(
    agents.map((a) => ({ type: a.type, name: a.name, isLead: a.isLead })),
    taskStatus,
  );

  // ═══════════════════════════════════════════════════════════
  // Phase 4: Run
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('🚀 Phase 4: Run');
  console.log('═'.repeat(60));

  const startTime = Date.now();
  const executionLog: Array<{ time: string; event: string }> = [];

  const results = await team.executeTasksParallel(tasks, {
    onProgress: (event: ProgressEvent) => {
      const timestamp = new Date().toLocaleTimeString();
      const agentName = event.agentName || 'Unknown';
      const taskName = event.taskName || event.taskId.slice(0, 8);

      // 更新任务状态
      const status = taskStatus.get(event.taskId);
      if (status) {
        status.status =
          event.type === 'start'
            ? 'in_progress'
            : event.type === 'complete'
              ? 'completed'
              : event.type === 'error'
                ? 'error'
                : status.status;
      }

      switch (event.type) {
        case 'start':
          console.log(`  [${timestamp}] 🚀 [${agentName}] 开始执行任务...`);
          console.log(
            `      📝 任务: ${event.message?.replace('开始执行: ', '') || taskName}`,
          );
          executionLog.push({ time: timestamp, event: `START [${agentName}]` });
          break;
        case 'complete':
          console.log(`  [${timestamp}] ✅ [${agentName}] 任务完成`);
          executionLog.push({ time: timestamp, event: `DONE [${agentName}]` });
          // 显示更新后的 Agent 状态
          displayAgentPanel(
            agents.map((a) => ({
              type: a.type,
              name: a.name,
              isLead: a.isLead,
            })),
            taskStatus,
          );
          break;
        case 'error':
          console.log(
            `  [${timestamp}] ❌ [${agentName}] 失败: ${event.message}`,
          );
          executionLog.push({ time: timestamp, event: `ERROR [${agentName}]` });
          break;
        case 'waiting':
          console.log(`  [${timestamp}] ⏳ 等待依赖任务完成...`);
          break;
      }
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // ═══════════════════════════════════════════════════════════
  // Phase 5: Synthesize
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('🔄 Phase 5: Synthesize');
  console.log('═'.repeat(60));

  const leadAgent = team.getLead();
  if (leadAgent) {
    console.log(`\n  👑 Lead Agent [${leadAgent.name}] 正在整合结果...`);
  }

  const finalResult = await team.synthesizeResults(tasks);

  // ═══════════════════════════════════════════════════════════
  // 最终结果
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('📄 最终结果');
  console.log('═'.repeat(60));
  console.log(finalResult);

  // 显示输出位置
  const outputLocations = extractOutputLocations(
    results.map((r) => ({
      agentType: r.agentType,
      output: r.output,
      toolCalls: r.toolCalls,
    })),
  );
  displayOutputLocations(outputLocations);

  // ═══════════════════════════════════════════════════════════
  // 执行统计
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('📊 执行统计');
  console.log('═'.repeat(60));

  const successCount = results.filter((r) => r.success).length;
  console.log(`  ⏱️  总耗时: ${elapsed}s`);
  console.log(`  ✅ 成功任务: ${successCount}/${results.length}`);

  const totalToolCalls = results.reduce(
    (sum, r) => sum + (r.toolCalls?.length ?? 0),
    0,
  );
  if (totalToolCalls > 0) {
    console.log(`  🔧 工具调用: ${totalToolCalls} 次`);

    // 显示工具调用详情
    const toolUsage = new Map<string, number>();
    results.forEach((r) => {
      r.toolCalls?.forEach((tc) => {
        toolUsage.set(tc.tool, (toolUsage.get(tc.tool) || 0) + 1);
      });
    });
    console.log('  📈 工具使用统计:');
    toolUsage.forEach((count, tool) => {
      console.log(`     • ${tool}: ${count} 次`);
    });
  }

  // 显示执行日志摘要
  if (executionLog.length > 0) {
    console.log('\n  📋 执行日志:');
    executionLog.slice(-5).forEach((log) => {
      console.log(`     [${log.time}] ${log.event}`);
    });
    if (executionLog.length > 5) {
      console.log(`     ... 共 ${executionLog.length} 条记录`);
    }
  }

  console.log('\n' + '═'.repeat(60));
}

run().catch((err) => {
  console.error('\n❌ 错误:', err.message);
  if (process.env.DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
});
