// ─── Sub Agent Types ───────────────────────────────────────────────────────────

import type { ToolSchema, LLMClient, AgentCallbacks } from '../../llm/types.js';

export type AgentType = 'vision' | 'main';

export interface SubAgentConfig {
  type: AgentType;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  maxIterations?: number;
}

export interface SubAgentToolContext {
  llmClient: LLMClient;
  baseRegistry: {
    getSchemas: () => ToolSchema[];
    dispatch: (name: string, input: Record<string, unknown>) => Promise<string>;
    dispatchWithConfirmation: (
      name: string,
      input: Record<string, unknown>,
      confirmFn?: (preview: string) => Promise<boolean>,
    ) => Promise<string>;
  };
  abortSignal?: AbortSignal;
  callbacks?: AgentCallbacks;
  parentToolUseId?: string;
}

export interface RoutedPlanStep {
  index: number;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  agentType?: AgentType;
  result?: string;
}

export interface RoutedPlan {
  id: string;
  goal: string;
  steps: RoutedPlanStep[];
  status: 'pending' | 'running' | 'done';
}

export interface SubRegistry {
  getSchemas: () => ToolSchema[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<string>;
  dispatchWithConfirmation: (
    name: string,
    input: Record<string, unknown>,
    confirmFn?: (preview: string) => Promise<boolean>,
  ) => Promise<string>;
}
