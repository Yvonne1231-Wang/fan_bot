// ─── Skill Types ─────────────────────────────────────────────────────────────

export interface SkillStats {
  usageCount: number;
  successCount: number;
  lastUsedAt: number;
  averageRating?: number;
}

export interface SkillMetadata {
  name: string;
  description: string;
  alwaysActive?: boolean;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  /** 技能来源：manual（人工创建）| auto（自动提取） */
  source?: 'manual' | 'auto';
  /** 使用统计 */
  stats?: SkillStats;
  /** 版本号，每次优化递增 */
  version?: number;
}

export interface Skill {
  metadata: SkillMetadata;
  content: string;
  baseDir: string;
}

export interface SkillsLoaderConfig {
  extraDirs?: string[];
  watch?: boolean;
  watchDebounceMs?: number;
}

export interface LoadedSkills {
  bundled: Skill[];
  extra: Skill[];
}

export interface SkillEntry {
  name: string;
  description: string;
  location: string;
  alwaysActive: boolean;
}

// ─── Skill Extraction Types ─────────────────────────────────────────────────

export interface SkillCandidate {
  /** 建议的技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 为什么这段对话值得提炼为技能 */
  reason: string;
  /** 置信度 0-1 */
  confidence: number;
  /** 涉及的工具名列表 */
  toolNames: string[];
}

export interface SkillDraft {
  /** 技能名称 */
  name: string;
  /** 生成的 SKILL.md 完整内容 */
  content: string;
  /** 来源对话的 session 标识（用于溯源） */
  sourceSessionId?: string;
}

export interface SkillExtractionConfig {
  /** 自动提取阈值：tool_use 数量达到此值才进入 LLM 评估 */
  minToolUses: number;
  /** 是否需要人工确认 */
  requireConfirmation: boolean;
  /** 待确认技能的过期天数 */
  pendingExpireDays: number;
}

export const DEFAULT_EXTRACTION_CONFIG: SkillExtractionConfig = {
  minToolUses: 3,
  requireConfirmation: true,
  pendingExpireDays: 7,
};
