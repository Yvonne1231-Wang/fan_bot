// ─── Agent Loop ─────────────────────────────────────────────────────────────

import type {
  LLMClient,
  LLMResponse,
  Message,
  ContentBlock,
  ToolUseBlock,
  AgentCallbacks,
} from '../llm/types.js';
import type { ToolRegistry } from '../tools/types.js';
import type { MemoryService } from '../memory/types.js';
import { createDebug } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';

const log = createDebug('agent:loop');

const MAX_TOOL_RESULT_CHARS = 15000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RunAgentOptions {
  prompt: string;
  llmClient: LLMClient;
  toolRegistry: ToolRegistry;
  initialMessages?: Message[];
  maxIterations?: number;
  systemPrompt?: string;
  onText?: (delta: string) => void;
  confirmFn?: (preview: string) => Promise<boolean>;
  abortSignal?: AbortSignal;
  memory?: MemoryService;
  autoExtractMemory?: boolean;
  callbacks?: AgentCallbacks;
}

export interface AgentResult {
  response: string;
  messages: Message[];
  iterations: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export class AgentLoopError extends Error {
  constructor(iterations: number) {
    super(`Agent loop exceeded maximum iterations (${iterations})`);
    this.name = 'AgentLoopError';
  }
}

// ─── Helper Functions ─────────────────────────────────────────────────────

function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

function userMessage(content: string | ContentBlock[]): Message {
  return {
    role: 'user',
    content: typeof content === 'string' ? [textBlock(content)] : content,
  };
}

function assistantMessage(content: ContentBlock[]): Message {
  return {
    role: 'assistant',
    content,
  };
}

/**
 * 构建工具结果 content block，对超长结果自动截断
 */
function toolResultBlock(
  toolUseId: string,
  content: string,
  isError = false,
): ContentBlock {
  let truncatedContent = content;
  if (content.length > MAX_TOOL_RESULT_CHARS) {
    log.warn(
      `Tool result truncated: ${content.length} -> ${MAX_TOOL_RESULT_CHARS} chars`,
    );
    truncatedContent =
      content.slice(0, MAX_TOOL_RESULT_CHARS) +
      '\n\n[... output truncated due to size limit ...]';
  }

  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: truncatedContent,
    is_error: isError,
  };
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

function hasRepetitiveContent(text: string, minRepeats = 3): boolean {
  if (!text || text.length < 10) return false;

  const sentences = text
    .split(/[.。!！?？\n]/)
    .filter((s) => s.trim().length > 3);
  if (sentences.length < minRepeats) return false;

  const first = sentences[0].trim();
  const matches = sentences.filter((s) => s.trim() === first);
  if (matches.length >= minRepeats) return true;

  for (let len = 10; len <= 50; len += 10) {
    const pattern = text.slice(0, len);
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(pattern, pos)) !== -1) {
      count++;
      pos += len;
    }
    if (count >= minRepeats) return true;
  }

  return false;
}

function isConverging(messages: Message[]): boolean {
  if (messages.length < 3) return false;

  const recent = messages.slice(-3);

  if (isToolLoop(recent)) {
    return true;
  }

  const texts = recent.map((m) => extractText(m.content));
  const nonEmpty = texts.filter((t) => t.length > 10);
  if (nonEmpty.length < 3) return false;
  return nonEmpty[0] === nonEmpty[1] && nonEmpty[1] === nonEmpty[2];
}

function isToolLoop(messages: Message[]): boolean {
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  const recentAssistant = assistantMessages.slice(-3);
  const recentToolCalls: Array<{ name: string; input: string }> = [];

  for (const msg of recentAssistant) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        recentToolCalls.push({
          name: block.name,
          input: JSON.stringify(block.input),
        });
      }
    }
  }

  if (recentToolCalls.length < 3) return false;

  const last = recentToolCalls[recentToolCalls.length - 1];
  let matchCount = 1;

  for (let i = recentToolCalls.length - 2; i >= 0; i--) {
    const prev = recentToolCalls[i];
    if (prev.name === last.name && prev.input === last.input) {
      matchCount++;
    } else {
      break;
    }
  }

  return matchCount >= 3;
}

function isRetryable(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('overloaded') ||
    msg.includes('api_error') ||
    msg.includes('internal network') ||
    msg.includes('network failure') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  } = {},
): Promise<T> {
  const { maxRetries = 3, onRetry } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isRetryable(lastError) || attempt === maxRetries - 1) {
        throw lastError;
      }

      const delayMs = Math.min(1000 * Math.pow(2, attempt), 30000);
      onRetry?.(attempt + 1, delayMs, lastError);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

// ─── Main Agent Loop ──────────────────────────────────────────────────────

export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const {
    prompt,
    llmClient,
    toolRegistry,
    initialMessages = [],
    maxIterations = 10,
    systemPrompt,
    abortSignal,
    callbacks,
  } = options;

  const checkAbort = () => {
    if (abortSignal?.aborted) {
      throw new Error('Agent execution cancelled by user');
    }
  };

  const messages: Message[] = [...initialMessages];
  messages.push(userMessage(prompt));

  let iterations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    while (iterations < maxIterations) {
      checkAbort();
      iterations++;

      const toolSchemas = toolRegistry.getSchemas();

      let response: LLMResponse;
      if (llmClient.stream) {
        const streamCall = async (): Promise<LLMResponse> => {
          return llmClient.stream!(
            messages,
            toolSchemas,
            systemPrompt,
            (delta) => {
              callbacks?.onContentDelta?.(delta);
              options.onText?.(delta);
            },
            callbacks?.onThinking,
            options.abortSignal,
          );
        };

        response = await withRetry(streamCall, {
          maxRetries: 3,
          onRetry: (attempt, delayMs, error) => {
            log.warn(
              `Stream call failed (attempt ${attempt}/3), retrying in ${delayMs}ms: ${error.message}`,
            );
          },
        });
      } else {
        const callLLM = async () => {
          const result = await llmClient.chat(
            messages,
            toolSchemas,
            systemPrompt,
            options.abortSignal,
          );
          const text = extractText(result.content);
          callbacks?.onContentDelta?.(text);
          options.onText?.(text);
          return result;
        };

        response = await withRetry(callLLM, {
          maxRetries: 3,
          onRetry: (attempt, delayMs, error) => {
            log.warn(
              `LLM call failed (attempt ${attempt}/3), retrying in ${delayMs}ms: ${error.message}`,
            );
          },
        });
      }

      if (response.usage) {
        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;
      }

      messages.push(assistantMessage(response.content));

      const textPreview = extractText(response.content).slice(0, 100);
      log.debug(
        `iteration ${iterations}, stop_reason: ${response.stop_reason}, content blocks: ${response.content.length}, text: ${textPreview}`,
      );

      switch (response.stop_reason) {
        case 'end_turn': {
          const textResponse = extractText(response.content);
          if (hasRepetitiveContent(textResponse)) {
            log.warn('Detected repetitive content, forcing end');
            const truncated = textResponse.slice(0, 200);
            callbacks?.onComplete?.();
            return {
              response:
                truncated +
                '\n\n[Response truncated due to repetitive content]',
              messages,
              iterations,
              usage: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
              },
            };
          }
          if (isConverging(messages)) {
            log.warn('Detected converging loop, forcing end');
            callbacks?.onComplete?.();
            return {
              response: textResponse,
              messages,
              iterations,
              usage: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
              },
            };
          }
          callbacks?.onComplete?.();
          return {
            response: textResponse,
            messages,
            iterations,
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
            },
          };
        }

        case 'tool_use': {
          const toolUseBlocks = response.content.filter(
            (c): c is ToolUseBlock => c.type === 'tool_use',
          );
          log.debug(`tool_use blocks found: ${toolUseBlocks.length}`);
          log.debug(
            `response content types: ${response.content.map((c) => c.type).join(', ')}`,
          );

          const toolResults: ContentBlock[] = [];

          for (const toolUse of toolUseBlocks) {
            checkAbort();
            log.debug(`executing tool: ${toolUse.name}`);
            callbacks?.onToolStart?.(
              toolUse.name,
              toolUse.input,
              null,
              toolUse.id,
            );

            try {
              const result = await toolRegistry.dispatchWithConfirmation(
                toolUse.name,
                toolUse.input,
                options.confirmFn,
              );
              log.debug(`tool result: ${result.slice(0, 100)}`);
              callbacks?.onToolEnd?.(toolUse.name, result, null);
              toolResults.push(toolResultBlock(toolUse.id, result));
            } catch (error) {
              const message =
                getErrorMessage(error);
              log.error(`tool error: ${message}`);
              callbacks?.onToolEnd?.(toolUse.name, `Error: ${message}`, null);
              toolResults.push(
                toolResultBlock(toolUse.id, `Error: ${message}`, true),
              );
            }
          }

          messages.push(userMessage(toolResults));
          continue;
        }

        case 'max_tokens':
          callbacks?.onError?.('LLM response exceeded maximum token limit');
          throw new Error('LLM response exceeded maximum token limit');

        case 'stop_sequence':
          callbacks?.onComplete?.();
          return {
            response: extractText(response.content),
            messages,
            iterations,
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
            },
          };

        default:
          callbacks?.onError?.(`Unknown stop reason: ${response.stop_reason}`);
          throw new Error(`Unknown stop reason: ${response.stop_reason}`);
      }
    }
  } catch (error) {
    const message = getErrorMessage(error);
    log.error(`Agent error: ${message}`);
    callbacks?.onError?.(message);
    throw error;
  }

  callbacks?.onError?.(
    `Agent loop exceeded maximum iterations (${maxIterations})`,
  );
  throw new AgentLoopError(maxIterations);
}
