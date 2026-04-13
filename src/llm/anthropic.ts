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

const LLM_TIMEOUT_MS = 120000;
const MAX_CONTENT_BLOCKS_PER_MESSAGE = 100;

// ─── Types ──────────────────────────────────────────────────────────────────

interface AnthropicClientOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
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
    baseURL: options.baseURL,
  });

  const model = options.model ?? 'claude-sonnet-4-6';

  /**
   * 将内部消息转换为 Anthropic 格式，自动拆分 content blocks 超限的消息。
   * Anthropic API 对单条消息的 content blocks 数量有限制。
   */
  function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.content.length <= MAX_CONTENT_BLOCKS_PER_MESSAGE) {
        result.push({
          role: msg.role,
          content: msg.content.map(toAnthropicContent),
        });
        continue;
      }

      log.llm.anthropic.warn(
        `Anthropic: splitting message with ${msg.content.length} content blocks (limit: ${MAX_CONTENT_BLOCKS_PER_MESSAGE})`,
      );

      // 拆分策略：按 tool_result 和非 tool_result 分组
      const nonToolResults = msg.content.filter(
        (b) => b.type !== 'tool_result',
      );
      const toolResults = msg.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_result' }> =>
          b.type === 'tool_result',
      );

      // 第一条消息：非 tool_result + 前 N 个 tool_result
      const firstChunkSize = Math.min(
        MAX_CONTENT_BLOCKS_PER_MESSAGE - nonToolResults.length,
        toolResults.length,
      );

      if (firstChunkSize > 0) {
        result.push({
          role: msg.role,
          content: [
            ...nonToolResults.map(toAnthropicContent),
            ...toolResults.slice(0, firstChunkSize).map(toAnthropicContent),
          ],
        });
      } else if (nonToolResults.length > 0) {
        result.push({
          role: msg.role,
          content: nonToolResults
            .slice(0, MAX_CONTENT_BLOCKS_PER_MESSAGE)
            .map(toAnthropicContent),
        });
      }

      // 剩余 tool_result 拆分为额外的 user 消息
      let remaining = toolResults.slice(firstChunkSize);
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, MAX_CONTENT_BLOCKS_PER_MESSAGE);
        remaining = remaining.slice(MAX_CONTENT_BLOCKS_PER_MESSAGE);
        result.push({
          role: 'user',
          content: chunk.map(toAnthropicContent),
        });
      }
    }

    return result;
  }

  return {
    chat: async (
      messages: Message[],
      tools: ToolSchema[] = [],
      systemPrompt?: string,
      signal?: AbortSignal,
    ): Promise<LLMResponse> => {
      const anthropicMessages = toAnthropicMessages(messages);

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

      const timeoutSignal = AbortSignal.timeout(LLM_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      const response = await client.messages.create(
        {
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: anthropicMessages,
          tools:
            anthropicTools.length > 0
              ? (anthropicTools as Anthropic.Tool[])
              : undefined,
        },
        { signal: combinedSignal },
      );

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

    stream: async (
      messages: Message[],
      tools: ToolSchema[] = [],
      systemPrompt: string | undefined,
      onChunk: (text: string) => void,
      onThinking?: (thinking: string) => void,
      signal?: AbortSignal,
    ): Promise<LLMResponse> => {
      const anthropicMessages = toAnthropicMessages(messages);

      const anthropicTools: Anthropic.Tool[] = tools.map(
        (tool: ToolSchema) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
        }),
      );

      const timeoutSignal = AbortSignal.timeout(LLM_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      const supportsThinking = model.startsWith('claude-');
      const response = await client.messages.create(
        {
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: anthropicMessages,
          tools:
            anthropicTools.length > 0
              ? (anthropicTools as Anthropic.Tool[])
              : undefined,
          thinking:
            onThinking && supportsThinking
              ? {
                  type: 'enabled',
                  budget_tokens: 10000,
                }
              : undefined,
          stream: true,
        },
        { signal: combinedSignal },
      );

      let fullContent: ContentBlock[] = [];
      let stopReason: LLMResponse['stop_reason'] = 'end_turn';
      let thinkingBuffer = '';

      for await (const event of response) {
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'thinking') {
            thinkingBuffer = '';
          } else if (event.content_block.type === 'text') {
            fullContent.push({ type: 'text', text: '' });
          } else if (event.content_block.type === 'tool_use') {
            const tb = event.content_block as Anthropic.ToolUseBlock;
            fullContent.push({
              type: 'tool_use',
              id: tb.id,
              name: tb.name,
              input: {},
            });
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'thinking_delta') {
            thinkingBuffer += event.delta.thinking;
            onThinking?.(event.delta.thinking);
          } else if (event.delta.type === 'text_delta') {
            if (thinkingBuffer) {
              thinkingBuffer = '';
              onThinking?.('');
            }
            const lastBlock = fullContent[fullContent.length - 1];
            if (lastBlock?.type === 'text') {
              lastBlock.text += event.delta.text;
              onChunk(event.delta.text);
            }
          } else if (event.delta.type === 'input_json_delta') {
            const lastBlock = fullContent[fullContent.length - 1];
            if (lastBlock?.type === 'tool_use') {
              try {
                lastBlock.input = JSON.parse(event.delta.partial_json || '{}');
              } catch {
                // Partial JSON, will be completed in next delta
              }
            }
          }
        } else if (event.type === 'message_delta') {
          stopReason = fromAnthropicStopReason(event.delta.stop_reason);
        }
      }

      if (thinkingBuffer) {
        onThinking?.('');
      }

      return {
        content: fullContent,
        stop_reason: stopReason,
      };
    },
  };
}
