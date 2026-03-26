// ─── Tool Registry Implementation ───────────────────────────────────────────

import type { Tool, ToolRegistry as IToolRegistry } from './types.js';
import type { ToolSchema } from '../llm/types.js';

// ─── Registry Implementation ────────────────────────────────────────────────

/**
 * In-memory tool registry.
 */
class Registry implements IToolRegistry {
  private tools = new Map<string, Tool>();

  /**
   * Register a tool.
   *
   * @param tool - The tool to register
   * @throws Error if tool with same name already exists
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.schema.name)) {
      throw new Error(`Tool '${tool.schema.name}' is already registered`);
    }
    this.tools.set(tool.schema.name, tool);
  }

  /**
   * Get all tool schemas for LLM.
   *
   * @returns Array of tool schemas
   */
  getSchemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map((t) => t.schema);
  }

  /**
   * Dispatch a tool call.
   *
   * @param name - Tool name
   * @param input - Tool input
   * @returns Tool result as string
   * @throws Error if tool not found or execution fails
   */
  async dispatch(
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found`);
    }

    try {
      return await tool.handler(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Tool '${name}' failed: ${message}`);
    }
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────────

const globalRegistry = new Registry();

export { globalRegistry as registry };

// ─── Convenience Exports ────────────────────────────────────────────────────

export const registerTool = (tool: Tool): void => globalRegistry.register(tool);
export const getToolSchemas = (): ToolSchema[] => globalRegistry.getSchemas();
export const dispatchTool = (
  name: string,
  input: Record<string, unknown>,
): Promise<string> => globalRegistry.dispatch(name, input);
