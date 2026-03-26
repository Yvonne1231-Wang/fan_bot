// ─── Tool Types ───────────────────────────────────────────────────────────

import type { ToolSchema } from '../llm/types.js';

// ─── Tool Interface ───────────────────────────────────────────────────────

/**
 * A tool that can be called by the agent.
 */
export interface Tool {
  /** Tool schema for LLM */
  schema: ToolSchema;

  /** Execute the tool with given input */
  handler: (input: Record<string, unknown>) => Promise<string>;
  riskLevel?: 'low' | 'medium' | 'high';
  requiresConfirmation?: boolean;
}

// ─── Tool Registry Interface ────────────────────────────────────────────────

/**
 * Interface for tool registry.
 */
export interface ToolRegistry {
  register(tool: Tool): void;
  getSchemas(): ToolSchema[];
  dispatch(name: string, input: Record<string, unknown>): Promise<string>;
  dispatchWithConfirmation(
    name: string,
    input: Record<string, unknown>,
    confirmFn?: (preview: string) => Promise<boolean>,
  ): Promise<string>;
}
