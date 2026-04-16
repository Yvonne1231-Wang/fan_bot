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

/**
 * 构建 vision sub-agent 的专用 schema（支持 image_path 参数）
 */
function buildVisionSchema(config: SubAgentConfig): Tool['schema'] {
  return {
    name: config.type,
    description:
      'Analyze images and visual content. You MUST provide image_path so the sub-agent can read the image file. Use this when you need to understand or describe what is in an image.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The analysis task to perform on the image',
        },
        image_path: {
          type: 'string',
          description:
            'The file path of the image to analyze (required for image tasks)',
        },
      },
      required: ['task'],
    },
  };
}

/**
 * 构建通用 sub-agent schema
 */
function buildGenericSchema(config: SubAgentConfig): Tool['schema'] {
  return {
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
  };
}

function createSubAgentTool(
  config: SubAgentConfig,
  ctx: SubAgentContext,
): Tool {
  const schema =
    config.type === 'vision'
      ? buildVisionSchema(config)
      : buildGenericSchema(config);

  return {
    schema,
    parallelSafe: config.type === 'vision',

    handler: async (input: Record<string, unknown>): Promise<string> => {
      const task = String(input.task);
      const imagePath = input.image_path ? String(input.image_path) : '';

      log.info(
        `Sub-agent '${config.type}' processing task: ${task.slice(0, 100)}${imagePath ? ` (image: ${imagePath})` : ''}`,
      );

      const subRegistry = buildSubRegistry(
        ctx.baseRegistry as import('../../tools/types.js').ToolRegistry,
        config.allowedTools,
      );

      let effectivePrompt = task;
      if (config.type === 'vision' && imagePath) {
        effectivePrompt = `${task}\n\nImage file to analyze: ${imagePath}\nUse the describe_image tool with path="${imagePath}" to analyze this image.`;
      }

      const agentOptions: RunAgentOptions = {
        prompt: effectivePrompt,
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
