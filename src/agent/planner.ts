import type { LLMClient, Message } from '../llm/types.js';

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
    [{
      role: 'user',
      content: [textBlock(`Break this task into clear numbered steps. Return ONLY a JSON array of step titles, nothing else.
Task: ${goal}`)],
    }],
    [],
    'You are a task planning assistant. Return ONLY valid JSON arrays like ["Step 1", "Step 2"].',
  );

  const text = response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text).join('');

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