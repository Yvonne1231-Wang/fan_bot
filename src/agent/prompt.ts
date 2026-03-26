import type { MemoryService } from '../memory/types.js';

export async function buildSystemPrompt(
  options: {
    agentName?: string;
    extraContext?: string;
    memory?: MemoryService;
    userQuery?: string;
  } = {},
): Promise<string> {
  const { agentName = 'Assistant', extraContext, memory, userQuery } = options;

  const base = `You are ${agentName}, a helpful AI assistant with access to tools.

When given a task:
1. Think through what needs to be done
2. Use tools when they would help (don't use tools for things you can answer directly)
3. Be concise and clear in your responses

Available tools will be described separately. Always prefer completing tasks over asking clarifying questions unless the task is genuinely ambiguous.`;

  let memoryContext = '';
  if (memory && userQuery) {
    const ctx = await memory.buildContext(userQuery);
    if (ctx) memoryContext = `\n\n${ctx}`;
  }

  const extra = extraContext ? `\n\n${extraContext}` : '';
  return base + memoryContext + extra;
}
