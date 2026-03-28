// ─── Skill Types ─────────────────────────────────────────────────────────────

export interface SkillMetadata {
  name: string;
  description: string;
  alwaysActive?: boolean;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
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
