// ─── OpenAI-Compatible LLM Client (Ark/Volcano) ───────────────────────────────

import OpenAI from 'openai';
import type {
  LLMClient,
  Message,
  ContentBlock,
  ToolSchema,
  LLMResponse,
  ToolUseBlock,
  ToolResultBlock,
} from './types.js';
import { createDebug } from '../utils/debug.js';
import { randomUUID } from 'crypto';

const log = createDebug('llm:openai');

// ─── Types ──────────────────────────────────────────────────────────────────

interface OpenAIClientOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  timeout?: number;
}

function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    // Try to extract first valid JSON object
    const match = str.match(/\{[^{}]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        // fallthrough
      }
    }
    return { _raw: str };
  }
}

// ─── Content Block Converters ───────────────────────────────────────────────

/**
 * Convert tool result blocks to OpenAI tool message format.
 * OpenAI uses separate 'tool' role messages for results instead of content blocks.
 */
function toolResultToOpenAIMessage(
  block: ToolResultBlock,
): OpenAI.Chat.ChatCompletionToolMessageParam {
  // ToolResultBlock.content can be string | Array<TextBlock | ImageBlock>
  // OpenAI SDK expects string for tool message content
  let content: string;
  if (typeof block.content === 'string') {
    content = block.content;
  } else if (Array.isArray(block.content)) {
    // Convert TextBlock | ImageBlock array to string
    content = block.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  } else {
    content = '';
  }

  return {
    role: 'tool',
    tool_call_id: block.tool_use_id,
    content,
  };
}

/**
 * Type guard for text content blocks.
 */
function isTextBlock(
  block: ContentBlock,
): block is { type: 'text'; text: string } {
  return block.type === 'text';
}

/**
 * Convert internal ContentBlock to OpenAI message content format.
 * Note: tool_result blocks are handled separately via toolResultToOpenAIMessage.
 * Always returns string for maximum compatibility with OpenAI SDK.
 */
function toOpenAIContent(blocks: ContentBlock[]): string {
  // Filter out tool_result blocks (handled separately) and tool_use (in separate field)
  const textBlocks = blocks.filter(isTextBlock);

  if (textBlocks.length === 0) {
    return '';
  }

  // Join all text blocks with newlines
  return textBlocks.map((b) => b.text).join('\n');
}

/**
 * Convert tool_use blocks to OpenAI tool_calls format.
 */
function toOpenAIToolCalls(
  blocks: ContentBlock[],
): OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined {
  const toolUseBlocks = blocks.filter(
    (b): b is ToolUseBlock => b.type === 'tool_use',
  );

  if (toolUseBlocks.length === 0) {
    return undefined;
  }

  return toolUseBlocks.map((b) => ({
    id: b.id,
    type: 'function' as const,
    function: {
      name: b.name,
      arguments: JSON.stringify(b.input),
    },
  }));
}

/**
 * Convert internal messages to OpenAI format.
 * This is the main entry point for message conversion.
 */
function toOpenAIMessages(
  messages: Message[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  // 第一遍：收集所有 assistant 消息中的 tool_call ID 和 tool_name 的映射
  // 旧格式的 ID (如 "shell:58") -> 新格式的 UUID (如 "tool_xxx")
  const idMapping = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const toolUseBlocks = msg.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );
      for (const block of toolUseBlocks) {
        // 如果当前 ID 不是 UUID 格式，生成一个新的 UUID
        if (!block.id.includes('-')) {
          const newId = `tool_${randomUUID()}`;
          idMapping.set(block.id, newId);
        } else {
          idMapping.set(block.id, block.id);
        }
      }
    }
  }

  for (const msg of messages) {
    const toolResults = msg.content
      .filter((b): b is ToolResultBlock => b.type === 'tool_result')
      .map((b) => {
        // 如果 tool_result 的 ID 有映射，使用映射后的 ID
        const mappedId = idMapping.get(b.tool_use_id) || b.tool_use_id;
        return {
          role: 'tool' as const,
          tool_call_id: mappedId,
          content:
            typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content
                    .filter(
                      (c): c is { type: 'text'; text: string } =>
                        c.type === 'text',
                    )
                    .map((c) => c.text)
                    .join('\n')
                : '',
        };
      });

    const content = toOpenAIContent(msg.content);

    // 处理 assistant 消息中的 tool_calls，使用映射后的 ID
    let toolCalls = toOpenAIToolCalls(msg.content);
    if (toolCalls) {
      toolCalls = toolCalls.map((tc) => ({
        ...tc,
        id: idMapping.get(tc.id) || tc.id,
      }));
    }

    if (msg.role === 'assistant' && toolCalls) {
      result.push({
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls,
      } as OpenAI.Chat.ChatCompletionAssistantMessageParam);
    } else if (msg.role === 'assistant') {
      result.push({
        role: 'assistant',
        content: content || null,
      } as OpenAI.Chat.ChatCompletionAssistantMessageParam);
    } else if (msg.role === 'user') {
      if (toolResults.length > 0 && !content) {
        result.push(...toolResults);
      } else {
        result.push({
          role: 'user',
          content,
        } as OpenAI.Chat.ChatCompletionUserMessageParam);
        result.push(...toolResults);
      }
    }
  }

  return result;
}

/**
 * Convert OpenAI response to internal LLMResponse format.
 */
function fromOpenAIResponse(
  response: OpenAI.Chat.Completions.ChatCompletion,
): LLMResponse {
  const choice = response.choices[0];
  if (!choice) {
    throw new Error('No choices in OpenAI response');
  }

  const message = choice.message;
  const content: ContentBlock[] = [];

  // Add text content if present
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  // Add tool calls if present
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      if (tc.type === 'function') {
        // 如果 ID 格式不正确（不是 UUID 格式），生成一个 UUID
        const toolUseId =
          tc.id && tc.id.includes('-') ? tc.id : `tool_${randomUUID()}`;
        content.push({
          type: 'tool_use',
          id: toolUseId,
          name: tc.function.name,
          input: safeParseJSON(tc.function.arguments),
        });
      }
    }
  }

  // Determine stop reason
  let stopReason: LLMResponse['stop_reason'];
  switch (choice.finish_reason) {
    case 'stop':
      stopReason = 'end_turn';
      break;
    case 'tool_calls':
      stopReason = 'tool_use';
      break;
    case 'length':
      stopReason = 'max_tokens';
      break;
    default:
      stopReason = 'end_turn';
  }

  return {
    content,
    stop_reason: stopReason,
    usage: response.usage
      ? {
          input_tokens: response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens,
        }
      : undefined,
  };
}

// ─── Client Implementation ──────────────────────────────────────────────────

/**
 * Create an OpenAI-compatible LLM client.
 * Works with Ark/Volcano AI and other OpenAI-compatible endpoints.
 *
 * @param options - Configuration options
 * @returns LLMClient implementation
 */
export function createOpenAIClient(options: OpenAIClientOptions): LLMClient {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    timeout: options.timeout ?? 120000, // 默认 2 分钟超时
  });

  const model = options.model ?? 'gpt-4o';

  return {
    async chat(
      messages: Message[],
      tools: ToolSchema[] = [],
      systemPrompt?: string,
      signal?: AbortSignal,
    ): Promise<LLMResponse> {
      const openaiMessages = toOpenAIMessages(messages);

      if (systemPrompt) {
        openaiMessages.unshift({
          role: 'system',
          content: systemPrompt,
        } as OpenAI.Chat.ChatCompletionSystemMessageParam);
      }

      const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map(
        (tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema as Record<string, unknown>,
          },
        }),
      );

      const response = await client.chat.completions.create(
        {
          model,
          messages: openaiMessages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
        },
        { signal },
      );

      return fromOpenAIResponse(response);
    },

    stream: async (
      messages: Message[],
      tools: ToolSchema[] = [],
      systemPrompt: string | undefined,
      onChunk: (text: string) => void,
      onThinking?: (thinking: string) => void,
      signal?: AbortSignal,
    ): Promise<LLMResponse> => {
      const openaiMessages = toOpenAIMessages(messages);

      if (systemPrompt) {
        openaiMessages.unshift({
          role: 'system',
          content: systemPrompt,
        } as OpenAI.Chat.ChatCompletionSystemMessageParam);
      }

      const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map(
        (tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema as Record<string, unknown>,
          },
        }),
      );

      const stream = await client.chat.completions.create(
        {
          model,
          messages: openaiMessages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
          stream: true,
        },
        { signal },
      );

      let fullContent: ContentBlock[] = [];
      let stopReason: LLMResponse['stop_reason'] = 'end_turn';
      const toolCalls = new Map<
        number,
        { id: string; name: string; args: string }
      >();

      for await (const chunk of stream) {
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }
        const delta = chunk.choices[0]?.delta;

        // Handle text content
        if (delta?.content) {
          if (
            fullContent.length === 0 ||
            fullContent[fullContent.length - 1].type !== 'text'
          ) {
            fullContent.push({ type: 'text', text: delta.content });
          } else {
            const lastBlock = fullContent[fullContent.length - 1];
            if (lastBlock.type === 'text') {
              lastBlock.text += delta.content;
            }
          }
          onChunk(delta.content);
        }

        // Handle tool calls (streaming)
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                args: tc.function?.arguments ?? '',
              });
            } else {
              const existing = toolCalls.get(idx)!;
              if (tc.id && !existing.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments)
                existing.args += tc.function.arguments;
            }
          }
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason === 'stop') {
          stopReason = 'end_turn';
        } else if (finishReason === 'tool_calls') {
          stopReason = 'tool_use';
        }
      }

      // Convert tool calls map to content blocks
      for (const [, tc] of toolCalls) {
        // 如果 ID 格式不正确（不是 UUID 格式），生成一个 UUID
        const toolUseId =
          tc.id && tc.id.includes('-') ? tc.id : `tool_${randomUUID()}`;
        fullContent.push({
          type: 'tool_use',
          id: toolUseId,
          name: tc.name,
          input: safeParseJSON(tc.args || '{}'),
        });
      }

      return {
        content: fullContent,
        stop_reason: stopReason,
      };
    },
  };
}
