// ─── Skill Extractor ─────────────────────────────────────────────────────────
//
// 从对话中自动识别可复用模式，提炼为技能。
// 采用两阶段流程：evaluate（快速判断）→ extract（LLM 提炼）。

import { readdir, readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { Message, ContentBlock, LLMClient } from '../llm/types.js';
import type {
  SkillCandidate,
  SkillDraft,
  SkillExtractionConfig,
} from './types.js';
import { DEFAULT_EXTRACTION_CONFIG } from './types.js';
import { getGlobalLoader } from './loader.js';
import { createDebug } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';

const log = createDebug('skills:extractor');

const PENDING_DIR = join(process.cwd(), '.fan_bot', 'pending_skills');
const AUTO_SKILLS_DIR = join(process.cwd(), '.fan_bot', 'skills');

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * 统计消息中的 tool_use 数量。纯计算，无 LLM 调用。
 */
export function countToolUses(messages: Message[]): number {
  let count = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') count++;
    }
  }
  return count;
}

/**
 * 检查用户消息是否包含显式的技能保存请求。
 */
export function hasExplicitSkillRequest(prompt: string): boolean {
  const patterns = [
    /以后都这样做/,
    /保存为技能/,
    /save\s+(as\s+)?skill/i,
    /记住这个(流程|方法|步骤)/,
    /以后.*自动/,
    /创建一个技能/,
    /create\s+a?\s*skill/i,
  ];
  return patterns.some((p) => p.test(prompt));
}

/**
 * 提取消息中使用的工具名列表（去重）。
 */
export function extractToolNames(messages: Message[]): string[] {
  const names = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        names.add(block.name);
      }
    }
  }
  return Array.from(names);
}

/**
 * 提取消息中的文本摘要（用于 LLM 评估输入）。
 */
function extractConversationSummary(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages.slice(-20)) {
    const texts: string[] = [];
    const tools: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'text') {
        texts.push(block.text.slice(0, 300));
      } else if (block.type === 'tool_use') {
        tools.push(block.name);
      }
    }
    if (texts.length > 0 || tools.length > 0) {
      const prefix = msg.role === 'user' ? 'User' : 'Assistant';
      let line = `${prefix}: ${texts.join(' ')}`;
      if (tools.length > 0) {
        line += ` [tools: ${tools.join(', ')}]`;
      }
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * 评估对话是否值得提炼为技能。
 * 返回 SkillCandidate 或 null（不值得）。
 */
export async function evaluateForSkill(
  messages: Message[],
  llmClient: LLMClient,
  config: SkillExtractionConfig = DEFAULT_EXTRACTION_CONFIG,
): Promise<SkillCandidate | null> {
  const toolCount = countToolUses(messages);
  if (toolCount < config.minToolUses) {
    log.debug(`Only ${toolCount} tool uses, below threshold ${config.minToolUses}`);
    return null;
  }

  // 检查是否与已有技能重复
  const toolNames = extractToolNames(messages);
  const existingSkills = getGlobalLoader().getAllSkills();
  const existingNames = new Set(existingSkills.map((s) => s.metadata.name));

  const summary = extractConversationSummary(messages);

  const evaluatePrompt = `Analyze this conversation and determine if it contains a reusable workflow pattern that should be saved as a skill.

Existing skills (avoid duplicates): ${Array.from(existingNames).join(', ') || 'none'}

Conversation:
${summary}

Respond in JSON format only:
{
  "isSkillWorthy": boolean,
  "name": "kebab-case-skill-name",
  "description": "One-line description of what the skill does",
  "reason": "Why this is worth saving as a reusable skill",
  "confidence": 0.0-1.0,
  "toolNames": ["tool1", "tool2"]
}

Rules:
- isSkillWorthy = true only if: multi-step workflow with clear pattern, likely to be reused
- isSkillWorthy = false if: one-off task, debugging/exploration, simple Q&A, already covered by existing skills
- confidence < 0.6 → not worth extracting
- name must be unique (not in existing skills list)`;

  try {
    const response = await llmClient.chat(
      [{ role: 'user', content: [{ type: 'text', text: evaluatePrompt }] }],
      [],
    );

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn('Failed to parse evaluate response as JSON');
      return null;
    }

    const result = JSON.parse(jsonMatch[0]) as {
      isSkillWorthy: boolean;
      name: string;
      description: string;
      reason: string;
      confidence: number;
      toolNames: string[];
    };

    if (!result.isSkillWorthy || result.confidence < 0.6) {
      log.debug(`Not skill-worthy: confidence=${result.confidence}, reason=${result.reason}`);
      return null;
    }

    if (existingNames.has(result.name)) {
      log.debug(`Skill "${result.name}" already exists, skipping`);
      return null;
    }

    log.info(
      `Skill candidate found: "${result.name}" (confidence: ${result.confidence})`,
    );

    return {
      name: result.name,
      description: result.description,
      reason: result.reason,
      confidence: result.confidence,
      toolNames: result.toolNames || toolNames,
    };
  } catch (error) {
    log.warn(`Skill evaluation failed: ${getErrorMessage(error)}`);
    return null;
  }
}

/**
 * 从对话中提炼技能，生成 SKILL.md 内容。
 */
export async function extractSkill(
  messages: Message[],
  candidate: SkillCandidate,
  llmClient: LLMClient,
): Promise<SkillDraft> {
  const summary = extractConversationSummary(messages);

  const extractPrompt = `Based on this conversation, create a reusable skill definition in SKILL.md format.

Skill name: ${candidate.name}
Skill description: ${candidate.description}
Tools used: ${candidate.toolNames.join(', ')}

Conversation:
${summary}

Generate the SKILL.md content with this exact format:

---
name: ${candidate.name}
description: ${candidate.description}
source: auto
version: 1
---

# ${candidate.name}

[Clear instructions for the agent on how to execute this skill]

## When to use
[Specific trigger conditions]

## Steps
[Numbered steps with tool calls and parameters]

## Notes
[Important caveats or edge cases]

Rules:
- Instructions should be actionable and specific
- Include actual tool names and typical parameters
- Write in the language of the original conversation
- Keep it concise but complete`;

  try {
    const response = await llmClient.chat(
      [{ role: 'user', content: [{ type: 'text', text: extractPrompt }] }],
      [],
    );

    const content = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      name: candidate.name,
      content: content.trim(),
    };
  } catch (error) {
    log.error(`Skill extraction failed: ${getErrorMessage(error)}`);
    throw error;
  }
}

// ─── Pending Skills Management ───────────────────────────────────────────────

export interface PendingSkill {
  candidate: SkillCandidate;
  draft: SkillDraft;
  createdAt: number;
  /** 技能来源的 chatId，用于精准推送通知 */
  sourceChatId?: string;
}

/**
 * 保存待确认的技能草稿。
 */
export async function savePendingSkill(pending: PendingSkill): Promise<void> {
  if (!existsSync(PENDING_DIR)) {
    await mkdir(PENDING_DIR, { recursive: true });
  }
  const filePath = join(PENDING_DIR, `${pending.candidate.name}.json`);
  await writeFile(filePath, JSON.stringify(pending, null, 2));
  log.info(`Saved pending skill: "${pending.candidate.name}"`);
}

/**
 * 列出所有待确认技能。
 */
export async function listPendingSkills(): Promise<PendingSkill[]> {
  if (!existsSync(PENDING_DIR)) return [];

  const files = await readdir(PENDING_DIR);
  const results: PendingSkill[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(PENDING_DIR, file), 'utf-8');
      results.push(JSON.parse(raw) as PendingSkill);
    } catch (error) {
      log.warn(`Failed to read pending skill ${file}: ${getErrorMessage(error)}`);
    }
  }

  return results;
}

/**
 * 确认并安装待确认技能。
 */
export async function confirmPendingSkill(name: string): Promise<boolean> {
  const pendingPath = join(PENDING_DIR, `${name}.json`);
  if (!existsSync(pendingPath)) {
    log.warn(`Pending skill "${name}" not found`);
    return false;
  }

  const raw = await readFile(pendingPath, 'utf-8');
  const pending = JSON.parse(raw) as PendingSkill;

  // 写入 .fan_bot/skills/{name}/SKILL.md
  const skillDir = join(AUTO_SKILLS_DIR, name);
  if (!existsSync(skillDir)) {
    await mkdir(skillDir, { recursive: true });
  }
  await writeFile(join(skillDir, 'SKILL.md'), pending.draft.content);

  // 删除 pending
  await unlink(pendingPath);

  log.info(`Skill "${name}" confirmed and installed at ${skillDir}`);
  return true;
}

/**
 * 拒绝待确认技能。
 */
export async function rejectPendingSkill(name: string): Promise<boolean> {
  const pendingPath = join(PENDING_DIR, `${name}.json`);
  if (!existsSync(pendingPath)) return false;

  await unlink(pendingPath);
  log.info(`Pending skill "${name}" rejected and removed`);
  return true;
}

/**
 * 清理过期的待确认技能。
 */
export async function cleanupExpiredPending(
  expireDays: number = DEFAULT_EXTRACTION_CONFIG.pendingExpireDays,
): Promise<number> {
  const pending = await listPendingSkills();
  const cutoff = Date.now() - expireDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const p of pending) {
    if (p.createdAt < cutoff) {
      await rejectPendingSkill(p.candidate.name);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log.info(`Cleaned up ${cleaned} expired pending skills`);
  }
  return cleaned;
}
