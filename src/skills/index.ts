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
