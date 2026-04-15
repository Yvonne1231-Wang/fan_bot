// ─── Skills Module ─────────────────────────────────────────────────────────────

export {
  SkillsLoader,
  loadAllSkills,
  getGlobalLoader,
  getSkillEntries,
  formatSkillsForPrompt,
  getSkillContent,
  xmlEscape,
  loadSkillTools,
} from './loader.js';

export type {
  Skill,
  SkillMetadata,
  SkillEntry,
  SkillsLoaderConfig,
  LoadedSkills,
} from './types.js';

export {
  loadSkillStats,
  saveSkillStats,
  recordSkillUsage,
} from './loader.js';

export {
  countToolUses,
  hasExplicitSkillRequest,
  extractToolNames,
  evaluateForSkill,
  extractSkill,
  savePendingSkill,
  listPendingSkills,
  confirmPendingSkill,
  rejectPendingSkill,
  cleanupExpiredPending,
} from './extractor.js';

export type {
  SkillStats,
  SkillCandidate,
  SkillDraft,
  SkillExtractionConfig,
} from './types.js';

export { DEFAULT_EXTRACTION_CONFIG } from './types.js';
