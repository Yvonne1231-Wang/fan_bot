import { randomUUID } from 'crypto';
import type { LLMClient } from '../../llm/types.js';
import type {
  TeamAgent,
  TeamTask,
  TeamConfig,
  TeamMessage,
  AgentExecutionResult,
  ProgressEvent,
} from './types.js';
import { runAgent } from '../loop.js';
import type { AgentResult } from '../loop.js';
import { createDebug } from '../../utils/debug.js';
import { getAgentPrompt, AGENT_PROMPTS } from './agent-prompts.js';
import { getAgentToolRegistry } from './agent-tools.js';

const debug = createDebug('agent:team');

const timestamp = () => new Date().toISOString().slice(11, 19);

interface AgentTypeInfo {
  type: string;
  name: string;
  description: string;
  defaultPrompt: string;
}

export class AgentTeam {
  private config: TeamConfig;
  private agents: TeamAgent[] = [];
  private tasks: TeamTask[] = [];
  private messages: TeamMessage[] = [];

  constructor(config: TeamConfig) {
    this.config = config;
    if (config.teammates) {
      this.agents = [...config.teammates];
    }
    if (config.lead) {
      this.agents.push(config.lead);
    }
  }

  static getAvailableAgentTypes(): AgentTypeInfo[] {
    return [
      {
        type: 'coder',
        name: '程序员',
        description: '编写和调试代码',
        defaultPrompt: AGENT_PROMPTS.coder,
      },
      {
        type: 'researcher',
        name: '研究员',
        description: '搜索和分析信息',
        defaultPrompt: AGENT_PROMPTS.researcher,
      },
      {
        type: 'analyzer',
        name: '分析师',
        description: '分析数据和趋势',
        defaultPrompt: AGENT_PROMPTS.analyzer,
      },
      {
        type: 'tester',
        name: '测试工程师',
        description: '编写测试用例',
        defaultPrompt: AGENT_PROMPTS.tester,
      },
      {
        type: 'documenter',
        name: '文档工程师',
        description: '编写文档',
        defaultPrompt: AGENT_PROMPTS.documenter,
      },
    ];
  }

  getAgents(): TeamAgent[] {
    return this.agents;
  }

  async planTask(prompt: string): Promise<TeamTask[]> {
    debug.info('Planning task: %s', prompt);

    const llmClient = this.config.llmClient;
    if (!llmClient) {
      throw new Error('LLM client is required for task planning');
    }

    const planningPrompt = `分析以下任务，将其分解为可执行的子任务：

任务：${prompt}

请按以下 JSON 格式返回子任务列表：
{
  "tasks": [
    {
      "name": "任务名称",
      "description": "任务详细描述",
      "agentType": "coder|researcher|analyzer|tester|documenter",
      "dependencies": ["依赖的任务名称"]
    }
  ]
}

规则：
- 简单任务只返回一个子任务
- 复杂任务分解为 2-5 个子任务
- 每个子任务分配最合适的 Agent 类型`;
    const response = await llmClient.chat(
      [{ role: 'user', content: [{ type: 'text', text: planningPrompt }] }],
      [],
      undefined,
    );

    const text = response.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');

    const jsonMatch = text.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
    if (!jsonMatch) {
      return [this.createSimpleTask(prompt)];
    }

    interface PlannedTask {
      name: string;
      description: string;
      agentType: string;
      dependencies?: string[];
    }

    const parsed = JSON.parse(jsonMatch[0]) as { tasks: PlannedTask[] };
    const plannedTasks = parsed.tasks || [];

    const nameToId = new Map<string, string>();
    plannedTasks.forEach((t) => {
      nameToId.set(t.name, randomUUID());
    });

    this.tasks = plannedTasks.map((t) => {
      const agent = this.findOrCreateAgent(t.agentType);
      const deps = (t.dependencies || [])
        .map((depName) => nameToId.get(depName))
        .filter((id): id is string => !!id);

      return {
        id: nameToId.get(t.name) || randomUUID(),
        name: t.name,
        description: t.description,
        assignee: agent,
        status: 'pending' as const,
        dependencies: deps.length > 0 ? deps : undefined,
      };
    });

    return this.tasks;
  }

  async executeTask(task: TeamTask): Promise<AgentExecutionResult> {
    debug.info('Executing task: %s', task.description);

    task.status = 'in_progress';

    try {
      const executor = task.assignee;
      if (!executor) {
        throw new Error('Task has no assignee');
      }

      const llmClient = executor.llmClient || this.config.llmClient;
      if (!llmClient) {
        throw new Error('LLM client is required');
      }

      let toolRegistry = executor.toolRegistry;
      if (!toolRegistry) {
        toolRegistry = getAgentToolRegistry(executor.type);
      }
      if (!toolRegistry) {
        throw new Error(`Agent ${executor.type} has no tool registry`);
      }

      const taskPrompt = this.buildTaskPrompt(task, executor);

      const agentResult: AgentResult = await runAgent({
        prompt: taskPrompt,
        llmClient,
        toolRegistry,
        systemPrompt: executor.systemPrompt,
        maxIterations: 20,
        abortSignal: this.config.abortSignal,
        callbacks: {
          onContentDelta: (delta) => {
            debug(`[${timestamp()}] 📝 ${delta.slice(0, 50)}...`);
          },
        },
      });

      task.status = 'completed';
      task.result = agentResult.response;

      this.broadcastMessage({
        id: randomUUID(),
        fromAgent: executor.type,
        toAgent: 'lead',
        taskId: task.id,
        type: 'result',
        content: agentResult.response,
        timestamp: Date.now(),
      });

      return {
        taskId: task.id,
        agentType: executor.type,
        success: true,
        output: agentResult.response,
        toolCalls: this.extractToolCalls(agentResult.messages),
      };
    } catch (error) {
      task.status = 'error';
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        taskId: task.id,
        agentType: task.assignee?.type ?? 'unknown',
        success: false,
        output: '',
        error: errorMessage,
      };
    }
  }

  async synthesizeResults(tasks: TeamTask[]): Promise<string> {
    const llmClient = this.config.llmClient;
    if (!llmClient) {
      throw new Error('LLM client is required');
    }

    const results = tasks
      .map((t) => {
        const status = t.status === 'completed' ? '✅' : '❌';
        return `${status} [${t.assignee?.name || 'Unknown'}] ${t.description}\nResult: ${t.result || 'N/A'}`;
      })
      .join('\n\n');

    const synthesisPrompt = `整合以下任务执行结果，生成最终报告：

${results}

请生成简洁的最终总结。`;

    const response = await llmClient.chat(
      [{ role: 'user', content: [{ type: 'text', text: synthesisPrompt }] }],
      [],
      undefined,
    );

    return response.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
  }

  async executeTasksParallel(
    tasks: TeamTask[],
    options?: {
      concurrency?: number;
      onProgress?: (event: ProgressEvent) => void;
    },
  ): Promise<AgentExecutionResult[]> {
    const concurrency = options?.concurrency || 3;
    const onProgress = options?.onProgress;
    const results: AgentExecutionResult[] = [];

    const pendingTasks = [...tasks];
    const runningTasks: Map<string, Promise<AgentExecutionResult>> = new Map();

    const checkDependency = (task: TeamTask): boolean => {
      if (!task.dependencies || task.dependencies.length === 0) return true;
      return task.dependencies.every((depId) => {
        const depTask = tasks.find((t) => t.id === depId);
        return depTask?.status === 'completed';
      });
    };

    const executeAvailable = async (): Promise<void> => {
      while (pendingTasks.length > 0 && runningTasks.size < concurrency) {
        const availableIdx = pendingTasks.findIndex(checkDependency);
        if (availableIdx === -1) break;

        const [task] = pendingTasks.splice(availableIdx, 1);

        onProgress?.({
          type: 'start',
          taskId: task.id,
          taskName: task.name,
          agentName: task.assignee?.name,
          message: '开始执行: ' + task.description,
        });

        const promise = this.executeTask(task).then((result) => {
          runningTasks.delete(task.id);

          onProgress?.({
            type: result.success ? 'complete' : 'error',
            taskId: task.id,
            taskName: task.name,
            agentName: task.assignee?.name,
            message: result.success ? '任务完成' : result.error,
          });

          return result;
        });

        runningTasks.set(task.id, promise);
      }
    };

    const waitForRunning = async (): Promise<void> => {
      if (runningTasks.size === 0 && pendingTasks.length > 0) {
        onProgress?.({
          type: 'waiting',
          taskId: pendingTasks[0].id,
          message: '等待依赖任务完成...',
        });
      }

      while (runningTasks.size > 0) {
        const promise = Promise.race(runningTasks.values());
        const result = await promise;
        results.push(result);
        await executeAvailable();
      }
    };

    await executeAvailable();
    await waitForRunning();

    while (results.length < tasks.length) {
      const completedTaskIds = new Set(
        results.map((r) => r.taskId).filter((id): id is string => !!id),
      );
      const remaining = tasks.filter((t) => !completedTaskIds.has(t.id));
      if (remaining.length === 0) break;
      const result = await this.executeTask(remaining[0]);
      results.push(result);
    }

    return results;
  }

  getLead(): TeamAgent | undefined {
    return this.agents.find((a) => a.isLead) || this.agents[0];
  }

  private findOrCreateAgent(type: string): TeamAgent {
    let agent = this.agents.find((a) => a.type === type);
    if (!agent) {
      const prompt = getAgentPrompt(type);
      agent = {
        type,
        name: type.charAt(0).toUpperCase() + type.slice(1),
        abilities: [type],
        tools: [],
        systemPrompt: prompt || `You are a ${type} agent.`,
        toolRegistry: getAgentToolRegistry(type),
      };
      this.agents.push(agent);
    }
    return agent;
  }

  private createSimpleTask(prompt: string): TeamTask {
    const agent = this.findOrCreateAgent('coder');
    return {
      id: randomUUID(),
      name: 'main',
      description: prompt,
      assignee: agent,
      status: 'pending',
    };
  }

  private buildTaskPrompt(task: TeamTask, agent: TeamAgent): string {
    let prompt = `执行以下任务：\n\n${task.description}`;

    if (task.dependencies && task.dependencies.length > 0) {
      const depResults = task.dependencies
        .map((depId) => {
          const depTask = this.tasks.find((t) => t.id === depId);
          if (depTask?.result) {
            return `前置任务「${depTask.name}」的结果：\n${depTask.result}`;
          }
          return null;
        })
        .filter((r): r is string => !!r)
        .join('\n\n');

      if (depResults) {
        prompt += `\n\n${depResults}`;
      }
    }

    return prompt;
  }

  private broadcastMessage(message: TeamMessage): void {
    this.messages.push(message);
  }

  private extractToolCalls(
    messages: import('../../llm/types.js').Message[],
  ): AgentExecutionResult['toolCalls'] {
    const calls: AgentExecutionResult['toolCalls'] = [];
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          calls.push({
            tool: block.name,
            input: block.input as Record<string, unknown>,
            output: '',
          });
        }
      }
    }
    return calls;
  }
}
