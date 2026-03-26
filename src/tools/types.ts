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
}

// ─── Tool Registry Interface ────────────────────────────────────────────────

/**
 * Interface for tool registry.
 */
export interface ToolRegistry {
  /** Register a tool */
  register(tool: Tool): void;

  /** Get all tool schemas */
  getSchemas(): ToolSchema[];

  /** Dispatch a tool call */
  dispatch(name: string, input: Record<string, unknown>): Promise<string>;
}
