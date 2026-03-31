// ─── Sub Agent Factory ─────────────────────────────────────────────────────────
// 子 Agent 工厂：创建可被主 Agent 调用的工具

import type { Tool } from '../../tools/types.js';
import type { LLMClient } from '../../llm/types.js';
import type { AgentType, SubAgentConfig, SubRegistry } from './types.js';
import { VISION_AGENT_PROMPT } from './prompts.js';
import { buildSubRegistry } from './registry-builder.js';
import { runAgent, type RunAgentOptions, type AgentResult } from '../loop.js';
import { createDebug } from '../../utils/debug.js';

const log = createDebug('agent:sub:factory');

export const SUB_AGENT_CONFIGS: Record<AgentType, SubAgentConfig> = {
  vision: {
    type: 'vision',
    description:
      'Analyze images and visual content. Use this when you need to understand or describe what is in an image.',
    systemPrompt: VISION_AGENT_PROMPT,
    allowedTools: ['read_file', 'describe_image'],
    maxIterations: 5,
  },
  main: {
    type: 'main',
    description: 'Main agent - use default capabilities',
    systemPrompt: '',
    allowedTools: [],
  },
};

interface SubAgentContext {
  llmClient: LLMClient;
  baseRegistry: {
    getSchemas: () => import('../../llm/types.js').ToolSchema[];
    dispatch: (name: string, input: Record<string, unknown>) => Promise<string>;
    dispatchWithConfirmation: (
      name: string,
      input: Record<string, unknown>,
      confirmFn?: (preview: string) => Promise<boolean>,
    ) => Promise<string>;
  };
  abortSignal?: AbortSignal;
}

function createSubAgentTool(
  config: SubAgentConfig,
  ctx: SubAgentContext,
): Tool {
  return {
    schema: {
      name: config.type,
      description: config.description,
      input_schema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The task to delegate to this sub-agent',
          },
        },
        required: ['task'],
      },
    },

    handler: async (input: Record<string, unknown>): Promise<string> => {
      const task = String(input.task);

      log.info(
        `Sub-agent '${config.type}' processing task: ${task.slice(0, 100)}`,
      );

      const subRegistry = buildSubRegistry(
        ctx.baseRegistry as import('../../tools/types.js').ToolRegistry,
        config.allowedTools,
      );

      const agentOptions: RunAgentOptions = {
        prompt: task,
        llmClient: ctx.llmClient,
        toolRegistry:
          subRegistry as import('../../tools/types.js').ToolRegistry,
        systemPrompt: config.systemPrompt,
        maxIterations: config.maxIterations ?? 5,
        abortSignal: ctx.abortSignal,
      };

      const result = await runAgent(agentOptions);
      return result.response;
    },
  };
}

export function createSubAgentTools(ctx: SubAgentContext): Tool[] {
  return [createSubAgentTool(SUB_AGENT_CONFIGS.vision, ctx)];
}

export function getSubAgentConfig(type: AgentType): SubAgentConfig {
  return SUB_AGENT_CONFIGS[type];
}

export function getAllowedToolsForAgent(type: AgentType): string[] {
  return SUB_AGENT_CONFIGS[type].allowedTools;
}
