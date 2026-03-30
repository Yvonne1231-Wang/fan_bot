// ─── Sub Agent Registry Builder ────────────────────────────────────────────────
// 工具函数：为子 Agent 构建过滤后的工具注册表

import type { ToolRegistry } from '../../tools/types.js';
import type { ToolSchema } from '../../llm/types.js';
import { createDebug } from '../../utils/debug.js';

const log = createDebug('agent:sub:registry');

export interface SubRegistry {
  getSchemas: () => ToolSchema[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<string>;
  dispatchWithConfirmation: (
    name: string,
    input: Record<string, unknown>,
    confirmFn?: (preview: string) => Promise<boolean>,
  ) => Promise<string>;
}

export function buildSubRegistry(
  baseRegistry: ToolRegistry,
  allowedTools: string[],
): SubRegistry {
  return {
    getSchemas: () => {
      const schemas = baseRegistry.getSchemas().filter((s) =>
        allowedTools.includes(s.name),
      );
      log.debug(
        `buildSubRegistry: allowed=${allowedTools.join(',')}, filtered=${schemas.map((s) => s.name).join(',')}`,
      );
      return schemas;
    },

    dispatch: async (name: string, input: Record<string, unknown>) => {
      if (!allowedTools.includes(name)) {
        throw new Error(`Tool '${name}' is not available in this sub-agent`);
      }
      return baseRegistry.dispatch(name, input);
    },

    dispatchWithConfirmation: async (
      name: string,
      input: Record<string, unknown>,
      confirmFn?: (preview: string) => Promise<boolean>,
    ) => {
      if (!allowedTools.includes(name)) {
        throw new Error(`Tool '${name}' is not available in this sub-agent`);
      }
      return baseRegistry.dispatchWithConfirmation(name, input, confirmFn);
    },
  };
}
