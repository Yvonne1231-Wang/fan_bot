import type {
  LLMClient,
  Message,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../llm/types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('session:summarizer');

export interface SummaryMessage extends Message {
  role: 'assistant';
  content: ContentBlock[];
  _isSummary: true;
  _summaryRange: {
    startIndex: number;
    endIndex: number;
    originalCount: number;
  };
}

export function isSummaryMessage(msg: Message): msg is SummaryMessage {
  return (msg as SummaryMessage)._isSummary === true;
}

export async function summarizeMessages(
  messages: Message[],
  llmClient: LLMClient,
): Promise<string> {
  const conversationText = messages
    .map((m) => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const text = m.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      const toolInfo = m.content
        .filter((c): c is ToolUseBlock => c.type === 'tool_use')
        .map((c) => `[Used tool: ${c.name}]`)
        .join('\n');
      const resultInfo = m.content
        .filter((c): c is ToolResultBlock => c.type === 'tool_result')
        .map((c) => {
          const content =
            typeof c.content === 'string' ? c.content : '[complex result]';
          return `[Tool result: ${content.slice(0, 1000)}...]`;
        })
        .join('\n');
      return `${role}: ${text}${toolInfo ? '\n' + toolInfo : ''}${resultInfo ? '\n' + resultInfo : ''}`;
    })
    .join('\n\n');

  const prompt = `Summarize the following conversation segment. Focus on:
1. Key decisions and outcomes
2. Important context that would be needed to continue the conversation
3. User preferences or requirements mentioned
4. Any ongoing tasks or unresolved questions

Be concise but comprehensive. Write in a neutral, factual tone.

Conversation:
${conversationText}

Output only the summary, nothing else.`;

  try {
    const response = await llmClient.chat(
      [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      [],
      undefined,
    );

    const summary = response.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');

    log.debug(`Generated summary: ${summary.slice(0, 100)}...`);
    return summary;
  } catch (error) {
    log.error(`Summarization failed: ${error}`);
    return `[Summary generation failed: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

export function createSummaryMessage(
  summary: string,
  startIndex: number,
  endIndex: number,
  originalCount: number,
): SummaryMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: `[Previous conversation summary]\n${summary}`,
      },
    ],
    _isSummary: true,
    _summaryRange: {
      startIndex,
      endIndex,
      originalCount,
    },
  };
}

export function estimateTokens(messages: Message[]): number {
  let totalTokens = 0;

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'text') {
        totalTokens += estimateTextTokens(block.text);
      } else if (block.type === 'tool_use') {
        totalTokens += Math.ceil(JSON.stringify(block.input).length / 4) + 10;
      } else if (block.type === 'tool_result') {
        const content =
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
        totalTokens += Math.ceil(content.length / 4) + 10;
      }
    }
    totalTokens += 4;
  }

  return totalTokens;
}

/**
 * 估算文本 token：CJK 按 1 字符≈1 token，其它按 4 字符≈1 token
 */
export function estimateTextTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return cjkChars + Math.ceil(otherChars / 4);
}

/**
 * 统计单条消息的 content blocks 数量
 */
export function countContentParts(message: Message): number {
  return message.content.length;
}

/**
 * 找出消息数组中 content parts 数量最多的消息及其索引
 */
export function findMaxContentPartsMessage(
  messages: Message[],
): { index: number; count: number } | null {
  let maxIndex = -1;
  let maxCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const count = countContentParts(messages[i]);
    if (count > maxCount) {
      maxCount = count;
      maxIndex = i;
    }
  }

  return maxIndex >= 0 ? { index: maxIndex, count: maxCount } : null;
}
