// ─── Persistent User Profile ────────────────────────────────────────────────
//
// Stores structured user preferences that get injected into every session's
// system prompt. Unlike vector-based memory recall, this is deterministic —
// zero recall latency, zero chance of missing important preferences.
//
// Storage: .fan_bot/user_profiles/{userId}.json

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { createDebug } from '../utils/debug.js';

const log = createDebug('user:profile');

const PROFILES_DIR = '.fan_bot/user_profiles';
const MAX_PROFILE_PROMPT_CHARS = 2000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UserPreferences {
  userId: string;
  updatedAt: number;
  /** 技术栈偏好：语言、框架、代码风格 */
  techPreferences: string[];
  /** 沟通偏好：详细/简洁、语言、格式 */
  communicationStyle: string[];
  /** 常用项目/仓库 */
  activeProjects: ProjectEntry[];
  /** 历史决策记录（"用户倾向于 X 而非 Y"） */
  decisions: DecisionEntry[];
  /** 自由形式备忘 */
  notes: string[];
}

export interface ProjectEntry {
  name: string;
  path?: string;
  description: string;
}

export interface DecisionEntry {
  topic: string;
  preference: string;
  date: number;
}

/** LLM 返回的增量更新结构 */
export interface ProfileUpdate {
  techPreferences?: string[];
  communicationStyle?: string[];
  activeProjects?: ProjectEntry[];
  decisions?: DecisionEntry[];
  notes?: string[];
}

// ─── Storage ────────────────────────────────────────────────────────────────

function getProfilePath(userId: string): string {
  return join(process.cwd(), PROFILES_DIR, `${userId}.json`);
}

export async function loadProfile(
  userId: string,
): Promise<UserPreferences | null> {
  const profilePath = getProfilePath(userId);

  if (!existsSync(profilePath)) {
    return null;
  }

  try {
    const content = await readFile(profilePath, 'utf-8');
    const profile = JSON.parse(content) as UserPreferences;
    log.debug(`Loaded profile for ${userId}: ${profile.techPreferences.length} tech prefs, ${profile.notes.length} notes`);
    return profile;
  } catch (error) {
    log.warn(`Failed to load profile for ${userId}: ${error}`);
    return null;
  }
}

export async function saveProfile(profile: UserPreferences): Promise<void> {
  const dir = join(process.cwd(), PROFILES_DIR);
  await mkdir(dir, { recursive: true });

  const profilePath = getProfilePath(profile.userId);
  await writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf-8');
  log.debug(`Saved profile for ${profile.userId}`);
}

function createEmptyProfile(userId: string): UserPreferences {
  return {
    userId,
    updatedAt: Date.now(),
    techPreferences: [],
    communicationStyle: [],
    activeProjects: [],
    decisions: [],
    notes: [],
  };
}

// ─── Merge Logic ────────────────────────────────────────────────────────────

/**
 * 增量合并更新到现有画像。去重基于字符串精确匹配。
 * 对于 decisions/projects 按 topic/name 去重。
 */
export function mergeProfileUpdate(
  existing: UserPreferences,
  update: ProfileUpdate,
): UserPreferences {
  const merged = { ...existing, updatedAt: Date.now() };

  if (update.techPreferences?.length) {
    const set = new Set(merged.techPreferences);
    for (const pref of update.techPreferences) {
      set.add(pref);
    }
    merged.techPreferences = [...set];
  }

  if (update.communicationStyle?.length) {
    const set = new Set(merged.communicationStyle);
    for (const style of update.communicationStyle) {
      set.add(style);
    }
    merged.communicationStyle = [...set];
  }

  if (update.activeProjects?.length) {
    const byName = new Map(
      merged.activeProjects.map((p) => [p.name, p]),
    );
    for (const project of update.activeProjects) {
      byName.set(project.name, project);
    }
    merged.activeProjects = [...byName.values()];
  }

  if (update.decisions?.length) {
    const byTopic = new Map(
      merged.decisions.map((d) => [d.topic, d]),
    );
    for (const decision of update.decisions) {
      // 新决策覆盖旧决策（同 topic）
      byTopic.set(decision.topic, decision);
    }
    merged.decisions = [...byTopic.values()];
  }

  if (update.notes?.length) {
    const set = new Set(merged.notes);
    for (const note of update.notes) {
      set.add(note);
    }
    merged.notes = [...set];
  }

  return merged;
}

// ─── Prompt Formatting ──────────────────────────────────────────────────────

/**
 * 将用户画像格式化为 system prompt 片段。
 * 如果画像为空或不存在，返回空字符串。
 * 输出限制在 MAX_PROFILE_PROMPT_CHARS 以内。
 */
export function formatProfileForPrompt(profile: UserPreferences): string {
  const sections: string[] = [];

  if (profile.techPreferences.length > 0) {
    sections.push(
      '### Tech Preferences\n' +
        profile.techPreferences.map((p) => `- ${p}`).join('\n'),
    );
  }

  if (profile.communicationStyle.length > 0) {
    sections.push(
      '### Communication Style\n' +
        profile.communicationStyle.map((s) => `- ${s}`).join('\n'),
    );
  }

  if (profile.activeProjects.length > 0) {
    sections.push(
      '### Active Projects\n' +
        profile.activeProjects
          .map((p) => `- **${p.name}**${p.path ? ` (${p.path})` : ''}: ${p.description}`)
          .join('\n'),
    );
  }

  if (profile.decisions.length > 0) {
    // 只保留最近 10 条决策
    const recent = profile.decisions.slice(-10);
    sections.push(
      '### Past Decisions\n' +
        recent.map((d) => `- ${d.topic}: ${d.preference}`).join('\n'),
    );
  }

  if (profile.notes.length > 0) {
    sections.push(
      '### Notes\n' +
        profile.notes.map((n) => `- ${n}`).join('\n'),
    );
  }

  if (sections.length === 0) {
    return '';
  }

  let result =
    '## User Profile\n\n' +
    'The following is known about this user from previous interactions. Use this to personalize your responses.\n\n' +
    sections.join('\n\n');

  // 硬限制，防止 prompt 过长
  if (result.length > MAX_PROFILE_PROMPT_CHARS) {
    result = result.slice(0, MAX_PROFILE_PROMPT_CHARS) + '\n\n[Profile truncated]';
  }

  return result;
}

// ─── High-level API ─────────────────────────────────────────────────────────

/**
 * 加载或创建用户画像，应用增量更新后保存。
 * 返回更新后的画像。
 */
export async function applyProfileUpdate(
  userId: string,
  update: ProfileUpdate,
): Promise<UserPreferences> {
  const existing = (await loadProfile(userId)) ?? createEmptyProfile(userId);
  const merged = mergeProfileUpdate(existing, update);
  await saveProfile(merged);
  return merged;
}

/**
 * 获取用户画像的 prompt 片段。
 * 如果画像不存在，返回空字符串。
 */
export async function getProfilePrompt(userId: string): Promise<string> {
  const profile = await loadProfile(userId);
  if (!profile) {
    return '';
  }
  return formatProfileForPrompt(profile);
}
