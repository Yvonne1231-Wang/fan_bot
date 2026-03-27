// ─── Agent Loop ─────────────────────────────────────────────────────────────

import type {
  LLMClient,
  Message,
  ContentBlock,
  ToolUseBlock,
} from '../llm/types.js';
import type { ToolRegistry } from '../tools/types.js';
import type { MemoryService } from '../memory/types.js';
import { createDebug } from '../utils/debug.js';
import { extractMemories } from './memory_extractor.js';

const log = createDebug('agent:loop');

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Options for running the agent loop.
 */
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
}

/**
 * Result of running the agent loop.
 */
export interface AgentResult {
  /** Final text response from the agent */
  response: string;

  /** Complete message history including this turn */
  messages: Message[];

  /** Number of iterations performed */
  iterations: number;

  /** Token usage if available */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Error thrown when agent loop exceeds maximum iterations.
 */
export class AgentLoopError extends Error {
  constructor(iterations: number) {
    super(`Agent loop exceeded maximum iterations (${iterations})`);
    this.name = 'AgentLoopError';
  }
}

// ─── Helper Functions ─────────────────────────────────────────────────────

/**
 * Create a text content block.
 */
function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

/**
 * Create a user message.
 */
function userMessage(content: string | ContentBlock[]): Message {
  return {
    role: 'user',
    content: typeof content === 'string' ? [textBlock(content)] : content,
  };
}

/**
 * Create an assistant message.
 */
function assistantMessage(content: ContentBlock[]): Message {
  return {
    role: 'assistant',
    content,
  };
}

/**
 * Create a tool result block.
 */
function toolResultBlock(
  toolUseId: string,
  content: string,
  isError = false,
): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
  };
}

/**
 * Extract text content from message content blocks.
 */
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
  const texts = recent.map((m) => extractText(m.content));
  const nonEmpty = texts.filter((t) => t.length > 10);
  if (nonEmpty.length < 3) return false;
  return nonEmpty[0] === nonEmpty[1] && nonEmpty[1] === nonEmpty[2];
}

/**
 * Check if an error is retryable (rate limit or server error).
 */
function isRetryable(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('overloaded')
  );
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call a function with exponential backoff retry.
 */
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

/**
 * Run the agent loop to completion.
 *
 * This function implements the core agent loop:
 * 1. Load/create message history
 * 2. Add user prompt
 * 3. Loop: call LLM, handle tool calls, repeat
 * 4. Return final response
 *
 * @param options - Configuration options
 * @returns Agent result with response and history
 * @throws AgentLoopError if max iterations exceeded
 * @throws Error if LLM call fails
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const {
    prompt,
    llmClient,
    toolRegistry,
    initialMessages = [],
    maxIterations = 10,
    systemPrompt,
    abortSignal,
  } = options;

  const checkAbort = () => {
    if (abortSignal?.aborted) {
      throw new Error('Agent execution cancelled by user');
    }
  };

  // Initialize message history
  const messages: Message[] = [...initialMessages];

  // Add user prompt
  messages.push(userMessage(prompt));

  // Track iterations and usage
  let iterations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Main loop
  while (iterations < maxIterations) {
    checkAbort();
    iterations++;

    // Get tool schemas
    const toolSchemas = toolRegistry.getSchemas();

    // Call LLM with retry for non-streaming, direct call for streaming
    let response;
    if (llmClient.stream) {
      response = await llmClient.stream(
        messages,
        toolSchemas,
        systemPrompt,
        options.onText ?? ((_) => {}),
        options.abortSignal,
      );
    } else {
      const callLLM = async () => {
        const result = await llmClient.chat(
          messages,
          toolSchemas,
          systemPrompt,
          options.abortSignal,
        );
        if (options.onText) {
          const text = extractText(result.content);
          options.onText(text);
        }
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

    // Track token usage
    if (response.usage) {
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
    }

    // Add assistant response to history
    messages.push(assistantMessage(response.content));

    // Handle stop reason
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
          return {
            response:
              truncated + '\n\n[Response truncated due to repetitive content]',
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
          log.debug(`executing tool: ${toolUse.name}`);
          try {
            const result = await toolRegistry.dispatchWithConfirmation(
              toolUse.name,
              toolUse.input,
              options.confirmFn,
            );
            log.debug(`tool result: ${result.slice(0, 100)}`);
            toolResults.push(toolResultBlock(toolUse.id, result));
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            log.error(`tool error: ${message}`);
            toolResults.push(
              toolResultBlock(toolUse.id, `Error: ${message}`, true),
            );
          }
        }

        messages.push(userMessage(toolResults));
        continue;
      }

      case 'max_tokens':
        throw new Error('LLM response exceeded maximum token limit');

      case 'stop_sequence':
        // Treat as complete
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
        throw new Error(`Unknown stop reason: ${response.stop_reason}`);
    }
  }

  // Max iterations exceeded
  throw new AgentLoopError(iterations);
}
