// ─── Agent Loop ─────────────────────────────────────────────────────────────

import type {
  LLMClient,
  Message,
  ContentBlock,
  ToolUseBlock,
} from '../llm/types.js';
import type { ToolRegistry } from '../tools/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Options for running the agent loop.
 */
export interface RunAgentOptions {
  /** User input prompt */
  prompt: string;

  /** LLM client for making API calls */
  llmClient: LLMClient;

  /** Tool registry for dispatching tool calls */
  toolRegistry: ToolRegistry;

  /** Optional initial messages (for continuing a session) */
  initialMessages?: Message[];

  /** Maximum number of iterations (default: 10) */
  maxIterations?: number;
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
  } = options;

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
    iterations++;

    // Get tool schemas
    const toolSchemas = toolRegistry.getSchemas();

    // Call LLM
    const response = await llmClient.chat(messages, toolSchemas);

    // Track token usage
    if (response.usage) {
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
    }

    // Add assistant response to history
    messages.push(assistantMessage(response.content));

    // Handle stop reason
    switch (response.stop_reason) {
      case 'end_turn': {
        // Conversation complete - return final response
        const textResponse = extractText(response.content);
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
        // Execute tools and collect results
        const toolUseBlocks = response.content.filter(
          (c): c is ToolUseBlock => c.type === 'tool_use',
        );

        const toolResults: ContentBlock[] = [];

        for (const toolUse of toolUseBlocks) {
          try {
            const result = await toolRegistry.dispatch(
              toolUse.name,
              toolUse.input,
            );
            toolResults.push(toolResultBlock(toolUse.id, result));
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            toolResults.push(
              toolResultBlock(toolUse.id, `Error: ${message}`, true),
            );
          }
        }

        // Add tool results as user message
        messages.push(userMessage(toolResults));

        // Continue loop
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
