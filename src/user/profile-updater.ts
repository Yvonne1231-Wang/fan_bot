// ─── Profile Updater ────────────────────────────────────────────────────────
//
// 对话结束后，用 LLM 分析对话是否包含新的用户偏好信息。
// 如果有，增量更新到持久化用户画像。

import type { LLMClient, Message } from '../llm/types.js';
import type { ProfileUpdate } from './profile.js';
import { applyProfileUpdate, loadProfile } from './profile.js';
import { createDebug } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';

const log = createDebug('user:profile-updater');

const EXTRACTION_PROMPT = `Analyze the conversation below and extract any NEW user preferences or profile information.

Focus ONLY on:
1. **techPreferences**: Programming languages, frameworks, tools, code style preferences (e.g., "prefers TypeScript strict mode", "uses Vim")
2. **communicationStyle**: How the user likes to communicate (e.g., "prefers concise answers", "likes detailed explanations", "communicates in Chinese")
3. **activeProjects**: Projects the user is working on (name + description)
4. **decisions**: Important decisions or preferences expressed (e.g., "prefers React over Vue", "always uses ESLint")
5. **notes**: Other important facts about the user

Rules:
- Only extract CLEAR, EXPLICIT preferences — do not infer or guess
- Skip temporary requests or one-off instructions
- Skip information that is generic or not user-specific
- Each entry should be a concise, self-contained statement

Output format (JSON only, no other text):
{
  "hasUpdates": false
}

OR if there are updates:
{
  "hasUpdates": true,
  "updates": {
    "techPreferences": ["prefers TypeScript strict mode"],
    "communicationStyle": ["prefers concise answers in Chinese"],
    "activeProjects": [{"name": "fan_bot", "description": "AI assistant framework"}],
    "decisions": [{"topic": "code style", "preference": "always use named exports"}],
    "notes": ["works at a tech company"]
  }
}

Only include sections that have actual new information. Omit empty arrays.`;

interface ExtractionResult {
  hasUpdates: boolean;
  updates?: ProfileUpdate;
}

/**
 * 从对话中提取用户画像更新。
 * 返回是否有更新，以及更新内容。
 */
export async function extractProfileUpdates(
  messages: Message[],
  llmClient: LLMClient,
  userId: string,
): Promise<{ updated: boolean; profile: ProfileUpdate | null }> {
  try {
    // 构建对话文本
    const conversationText = messages
      .map((m) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const text = m.content
          .filter(
            (c): c is { type: 'text'; text: string } => c.type === 'text',
          )
          .map((c) => c.text)
          .join('\n');
        return `${role}: ${text}`;
      })
      .join('\n\n');

    // 加载现有画像，告诉 LLM 哪些已知，避免重复提取
    const existing = await loadProfile(userId);
    let existingContext = '';
    if (existing) {
      const knownItems: string[] = [];
      if (existing.techPreferences.length > 0) {
        knownItems.push(
          `Known tech preferences: ${existing.techPreferences.join(', ')}`,
        );
      }
      if (existing.communicationStyle.length > 0) {
        knownItems.push(
          `Known communication style: ${existing.communicationStyle.join(', ')}`,
        );
      }
      if (existing.decisions.length > 0) {
        knownItems.push(
          `Known decisions: ${existing.decisions.map((d) => `${d.topic}: ${d.preference}`).join(', ')}`,
        );
      }
      if (knownItems.length > 0) {
        existingContext = `\n\nAlready known about this user (do NOT re-extract these):\n${knownItems.join('\n')}`;
      }
    }

    const prompt = `${EXTRACTION_PROMPT}${existingContext}\n\nConversation:\n${conversationText}`;

    log.debug('Extracting profile updates from conversation...');
    const response = await llmClient.chat(
      [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      [],
      undefined,
    );

    const text = response.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.debug('No JSON found in profile extraction response');
      return { updated: false, profile: null };
    }

    const result = JSON.parse(jsonMatch[0]) as ExtractionResult;

    if (!result.hasUpdates || !result.updates) {
      log.debug('No profile updates found in conversation');
      return { updated: false, profile: null };
    }

    log.debug(`Profile updates found: ${JSON.stringify(result.updates)}`);
    return { updated: true, profile: result.updates };
  } catch (error) {
    log.error(`Profile extraction failed: ${getErrorMessage(error)}`);
    return { updated: false, profile: null };
  }
}

/**
 * 从对话中提取并应用用户画像更新。
 * 一站式 API：提取 → 合并 → 保存。
 */
export async function updateProfileFromConversation(
  messages: Message[],
  llmClient: LLMClient,
  userId: string,
): Promise<boolean> {
  const { updated, profile } = await extractProfileUpdates(
    messages,
    llmClient,
    userId,
  );

  if (!updated || !profile) {
    return false;
  }

  // 为 decisions 补充时间戳
  if (profile.decisions) {
    for (const decision of profile.decisions) {
      if (!decision.date) {
        decision.date = Date.now();
      }
    }
  }

  const result = await applyProfileUpdate(userId, profile);
  log.info(
    `Updated profile for ${userId}: ${result.techPreferences.length} tech prefs, ${result.decisions.length} decisions, ${result.notes.length} notes`,
  );
  return true;
}
