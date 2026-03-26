// ─── Anthropic LLM Client ───────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMClient,
  Message,
  ContentBlock,
  ToolSchema,
  LLMResponse,
} from './types.js';
import { log } from '../utils/debug.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface AnthropicClientOptions {
  apiKey: string;
  model?: string;
}

// ─── Content Block Converters ───────────────────────────────────────────────

/**
 * Convert internal ContentBlock to Anthropic's SDK format.
 */
function toAnthropicContent(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case 'tool_result': {
      // ToolResultBlock.content can be string | Array<TextBlock | ImageBlock>
      let content: Anthropic.TextBlockParam[] | undefined;
      if (typeof block.content === 'string') {
        content = block.content
          ? [{ type: 'text', text: block.content }]
          : undefined;
      } else if (Array.isArray(block.content) && block.content.length > 0) {
        // Convert TextBlock | ImageBlock to Anthropic format
        content = block.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => ({ type: 'text', text: c.text }));
      }
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content,
        is_error: block.is_error,
      };
    }
    default:
      // Exhaustive check
      throw new Error(
        `Unknown content block type: ${(block as { type: string }).type}`,
      );
  }
}

/**
 * Convert Anthropic's SDK content block to internal ContentBlock.
 */
function fromAnthropicContent(block: Anthropic.ContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    default:
      throw new Error(
        `Unexpected content block type: ${(block as { type: string }).type}`,
      );
  }
}

/**
 * Convert Anthropic's native stop_reason to internal format.
 */
function fromAnthropicStopReason(
  reason: Anthropic.Message['stop_reason'],
): LLMResponse['stop_reason'] {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

// ─── Client Implementation ──────────────────────────────────────────────────

/**
 * Create an Anthropic LLM client.
 *
 * @param options - Configuration options
 * @returns LLMClient implementation
 */
export function createAnthropicClient(
  options: AnthropicClientOptions,
): LLMClient {
  const client = new Anthropic({
    apiKey: options.apiKey,
  });

  const model = options.model ?? 'claude-sonnet-4-6';

  return {
    chat: async (
      messages: Message[],
      tools: ToolSchema[] = [],
    ): Promise<LLMResponse> => {
      const anthropicMessages: Anthropic.MessageParam[] = messages.map(
        (msg: Message) => ({
          role: msg.role,
          content: msg.content.map(toAnthropicContent),
        }),
      );

      log.llm.anthropic.verbose('Sending request', {
        model,
        messageCount: messages.length,
        toolCount: tools.length,
      });

      const anthropicTools: Anthropic.Tool[] = tools.map(
        (tool: ToolSchema) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
        }),
      );

      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        messages: anthropicMessages,
        tools:
          anthropicTools.length > 0
            ? (anthropicTools as Anthropic.Tool[])
            : undefined,
      });

      const result: LLMResponse = {
        stop_reason: fromAnthropicStopReason(response.stop_reason),
        content: response.content.map(
          (block): ContentBlock => fromAnthropicContent(block),
        ),
        usage: response.usage
          ? {
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
            }
          : undefined,
      };

      log.llm.anthropic.verbose('Received response', {
        stopReason: result.stop_reason,
        contentBlocks: result.content.length,
        usage: result.usage,
      });

      return result;
    },
  };
}
