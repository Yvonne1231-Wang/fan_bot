import Langfuse from 'langfuse';
import type { LangfuseTraceClient, LangfuseSpanClient, LangfuseGenerationClient } from 'langfuse';
import type { ObservabilityConfig, TraceContext } from './types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('observability:langfuse');

let langfuseClient: Langfuse | null = null;
let observabilityEnabled = false;

/**
 * 初始化 Langfuse 可观测性客户端。
 * 未配置 publicKey/secretKey 时静默跳过，不影响主流程。
 */
export function initObservability(config: ObservabilityConfig): void {
  if (config.enabled === false) {
    log.info('Observability disabled by config');
    observabilityEnabled = false;
    return;
  }

  if (!config.publicKey || !config.secretKey) {
    log.info('Langfuse keys not configured, observability disabled');
    observabilityEnabled = false;
    return;
  }

  langfuseClient = new Langfuse({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    release: config.release,
    sampleRate: config.sampleRate,
    flushAt: config.flushAt,
    flushInterval: config.flushInterval,
  });

  observabilityEnabled = true;
  log.info('Langfuse observability initialized', {
    baseUrl: config.baseUrl ?? 'https://cloud.langfuse.com',
    environment: config.environment,
  });
}

/**
 * 获取 Langfuse 客户端实例。
 * 未初始化时返回 null，调用方应做 null 检查。
 */
export function getLangfuse(): Langfuse | null {
  return langfuseClient;
}

/**
 * 查询可观测性是否已启用。
 */
export function isObservabilityEnabled(): boolean {
  return observabilityEnabled && langfuseClient !== null;
}

/**
 * 创建一次 Trace，代表一次完整的用户交互。
 */
export function createTrace(params: {
  name: string;
  sessionId?: string;
  userId?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
}): LangfuseTraceClient | null {
  if (!langfuseClient) return null;

  const trace = langfuseClient.trace({
    name: params.name,
    sessionId: params.sessionId,
    userId: params.userId,
    input: params.input,
    metadata: params.metadata,
    tags: params.tags,
  });

  log.debug('Trace created', { traceId: trace.id, name: params.name });
  return trace;
}

/**
 * 在 Trace 下创建一个 Span，代表一个逻辑步骤（如工具调用、记忆检索）。
 */
export function createSpan(
  trace: LangfuseTraceClient,
  params: {
    name: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  },
): LangfuseSpanClient | null {
  if (!langfuseClient) return null;

  const span = trace.span({
    name: params.name,
    input: params.input,
    metadata: params.metadata,
  });

  log.debug('Span created', { spanId: span.id, name: params.name });
  return span;
}

/**
 * 在 Trace 或 Span 下创建一个 Generation，代表一次 LLM 调用。
 */
export function createGeneration(
  parent: LangfuseTraceClient | LangfuseSpanClient,
  params: {
    name: string;
    model: string;
    provider?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  },
): LangfuseGenerationClient | null {
  if (!langfuseClient) return null;

  const generation = parent.generation({
    name: params.name,
    model: params.model,
    metadata: {
      provider: params.provider,
      ...params.metadata,
    },
    input: params.input,
  });

  log.debug('Generation created', { generationId: generation.id, model: params.model });
  return generation;
}

/**
 * 结束一个 Generation，记录输出和 token 用量。
 */
export function endGeneration(
  generation: LangfuseGenerationClient,
  params: {
    output?: unknown;
    usage?: {
      inputTokens: number;
      outputTokens: number;
    };
    metadata?: Record<string, unknown>;
  },
): void {
  generation.end({
    output: params.output,
    usage: params.usage
      ? {
          input: params.usage.inputTokens,
          output: params.usage.outputTokens,
          total: params.usage.inputTokens + params.usage.outputTokens,
        }
      : undefined,
    metadata: params.metadata,
  });
}

/**
 * 结束一个 Span，记录输出。
 */
export function endSpan(
  span: LangfuseSpanClient,
  params: {
    output?: unknown;
    metadata?: Record<string, unknown>;
    statusMessage?: string;
  },
): void {
  span.end({
    output: params.output,
    metadata: params.metadata,
    statusMessage: params.statusMessage,
  });
}

/**
 * 更新 Trace 的输出信息。
 */
export function updateTrace(
  trace: LangfuseTraceClient,
  params: {
    output?: unknown;
    metadata?: Record<string, unknown>;
  },
): void {
  trace.update({
    output: params.output,
    metadata: params.metadata,
  });
}

/**
 * 优雅关闭 Langfuse 客户端，确保所有缓冲事件已上报。
 * 应在应用退出时调用。
 */
export async function shutdownObservability(): Promise<void> {
  if (!langfuseClient) return;

  log.info('Shutting down Langfuse observability...');
  await langfuseClient.shutdownAsync();
  langfuseClient = null;
  observabilityEnabled = false;
  log.info('Langfuse observability shut down');
}
