import type { LangfuseTraceClient, LangfuseSpanClient, LangfuseGenerationClient } from 'langfuse';

export interface ObservabilityConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  enabled?: boolean;
  environment?: string;
  release?: string;
  sampleRate?: number;
  flushAt?: number;
  flushInterval?: number;
}

export interface TraceContext {
  trace: LangfuseTraceClient;
  sessionId?: string;
  userId?: string;
}

export interface LLMTraceParams {
  trace: LangfuseTraceClient;
  model: string;
  provider: string;
}

export interface ToolTraceParams {
  trace: LangfuseTraceClient;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

export interface MemoryTraceParams {
  trace: LangfuseTraceClient;
  operation: string;
  query?: string;
}
