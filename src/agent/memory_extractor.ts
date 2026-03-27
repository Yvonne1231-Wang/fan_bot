import type { LLMClient, Message } from '../llm/types.js';
import type { MemoryService } from '../memory/types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('agent:memory_extractor');

export interface MemoryExtractionResult {
  extracted: Array<{
    key: string;
    value: string;
    scope: 'user' | 'agent' | 'global';
  }>;
  reason: string;
}

export async function extractMemories(
  messages: Message[],
  llmClient: LLMClient,
  memory: MemoryService,
): Promise<MemoryExtractionResult> {
  const conversationText = messages
    .map((m) => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const text = m.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      return `${role}: ${text}`;
    })
    .join('\n\n');

  const prompt = `Analyze the following conversation and extract important information that should be remembered for future interactions.

Focus on:
1. User preferences, facts about the user, user's goals
2. Important decisions or agreements made
3. Context that would be useful in future conversations

Ignore:
- Temporary states or fleeting thoughts
- Information already likely to be remembered
- Generic pleasantries

Conversation:
${conversationText}

Output format (JSON):
{
  "extracted": [
    { "key": "job", "value": "engineer", "scope": "user" },
    { "key": "preference", "value": "likes dark mode", "scope": "user" }
  ],
  "reason": "Brief explanation of what was extracted and why"
}

If nothing important to remember, output:
{
  "extracted": [],
  "reason": "No significant information to remember"
}

Output only the JSON, nothing else.`;

  try {
    log.debug(`Extracting memories from conversation...`);
    const response = await llmClient.chat(
      [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      [],
      undefined,
    );

    const text = response.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');

    log.debug(`LLM response: ${text.slice(0, 200)}...`);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn('No JSON found in response');
      return { extracted: [], reason: 'No JSON found in response' };
    }

    const result = JSON.parse(jsonMatch[0]) as MemoryExtractionResult;
    log.debug(`Parsed result: ${JSON.stringify(result)}`);

    for (const item of result.extracted) {
      const existing = await memory.getFact(item.key);
      if (existing !== item.value) {
        await memory.remember(item.key, item.value, item.scope);
        log.info(`Remembered: ${item.key} = ${item.value} (${item.scope})`);
      }
    }

    return result;
  } catch (error) {
    log.error(`Memory extraction failed: ${error}`);
    return {
      extracted: [],
      reason: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
