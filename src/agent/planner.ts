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

export function shouldPlan(message: string): boolean {
  if (message.startsWith('/plan ')) return true;
  const planPatterns = [
    /先.{0,10}[，,].{0,20}(然后|接着|再)/,
    /分(步|阶段|批)/,
    /step\s*\d/i,
    /^\s*(帮我|请你|麻烦).{0,30}(然后|再|接着|最后)/,
  ];
  return planPatterns.some((p) => p.test(message));
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
