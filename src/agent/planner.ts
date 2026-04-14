import type { LLMClient, Message } from '../llm/types.js';
import type {
  AgentType,
  RoutedPlanStep,
  RoutedPlan as RoutedPlanInterface,
} from './sub-agents/types.js';

export interface PlanStep {
  index: number;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  status: 'pending' | 'running' | 'done';
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

export async function createPlan(
  goal: string,
  llmClient: LLMClient,
): Promise<Plan> {
  const response = await llmClient.chat(
    [
      {
        role: 'user',
        content: [
          textBlock(`Break this task into clear numbered steps. Return ONLY a JSON array of step titles, nothing else.
Task: ${goal}`),
        ],
      },
    ],
    [],
    'You are a task planning assistant. Return ONLY valid JSON arrays like ["Step 1", "Step 2"].',
  );

  const text = response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');

  let stepTitles: string[] = [];
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      stepTitles = JSON.parse(match[0]);
    }
  } catch {
    stepTitles = [text.trim()];
  }

  return {
    id: `plan-${Date.now()}`,
    goal,
    steps: stepTitles.map((title, i) => ({
      index: i,
      title,
      status: 'pending',
    })),
    status: 'pending',
  };
}

/**
 * CJK 字符占比，用于判断是否为中文为主的消息
 */
function cjkRatio(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || [])
    .length;
  return text.length > 0 ? cjk / text.length : 0;
}

/**
 * 语言感知的 token 估算（中文 1 字符 ≈ 1 token，英文 4 字符 ≈ 1 token）
 */
function estimatePlanTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch) ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

/**
 * 判断用户消息是否需要启动多步计划
 *
 * 使用语言感知的 token 阈值（而非字符长度），
 * 并对中文高频词做上下文约束以避免误触发。
 */
export function shouldPlan(message: string): boolean {
  if (message.startsWith('/plan ')) return true;

  const numberedListPattern =
    /(?:^|\n)\s*[1１][.、)）]\s*\S.*(?:\n\s*[2２][.、)）]\s*\S)/m;
  if (numberedListPattern.test(message)) return true;

  const stepKeywords = /步骤\s*[1-9１-９]|step\s*[1-9]/i;
  if (stepKeywords.test(message)) return true;

  const isCJK = cjkRatio(message) > 0.3;
  const MIN_PLAN_TOKENS = isCJK ? 20 : 30;
  if (estimatePlanTokens(message) < MIN_PLAN_TOKENS) return false;

  const ordinalWithAction =
    /第[一二三][，,：:、]?\s*(?:步|阶段)?[，,：:]?\s*(?:[\u4e00-\u9fff]{2,})/;
  if (ordinalWithAction.test(message)) {
    const ordinalCount = (message.match(/第[一二三四五六七八九十]/g) || [])
      .length;
    if (ordinalCount >= 2) return true;
  }

  const sequentialPattern =
    /先.{4,}[，,。；;].{0,20}(?:然后|接着|之后|再).{4,}[，,。；;].{0,20}(?:然后|接着|再|最后|并且).{4,}/;
  if (sequentialPattern.test(message)) return true;

  const explicitPlanKeywords = /分(步骤?|阶段|批次?)(进行|完成|实现|处理|执行)/;
  if (explicitPlanKeywords.test(message)) return true;

  return false;
}

export async function createRoutedPlan(
  goal: string,
  llmClient: LLMClient,
): Promise<RoutedPlanInterface> {
  const response = await llmClient.chat(
    [
      {
        role: 'user',
        content: [
          textBlock(`Analyze this task and break it into steps. For each step, determine which specialized agent should handle it.

Agents:
- vision: Image analysis, describe_image tool
- main: General tasks, default

Return ONLY a JSON array of objects with "title" and "agentType" fields. Nothing else.
Example: [{"title": "Analyze this image", "agentType": "vision"}]

Task: ${goal}`),
        ],
      },
    ],
    [],
    'You are a task planning assistant. Return ONLY valid JSON.',
  );

  const text = response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');

  interface ParsedStep {
    title: string;
    agentType: string;
  }

  let parsedSteps: ParsedStep[] = [];
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      parsedSteps = JSON.parse(match[0]);
    }
  } catch {
    return {
      id: `plan-${Date.now()}`,
      goal,
      steps: [{ index: 0, title: text.trim(), status: 'pending' }],
      status: 'pending',
    };
  }

  const validAgentTypes: AgentType[] = ['vision', 'main'];

  return {
    id: `plan-${Date.now()}`,
    goal,
    steps: parsedSteps.map((step, i) => ({
      index: i,
      title: step.title,
      status: 'pending' as const,
      agentType: validAgentTypes.includes(step.agentType as AgentType)
        ? (step.agentType as AgentType)
        : 'main',
    })),
    status: 'pending',
  };
}
