// ─── Skills Loader ────────────────────────────────────────────────────────────

import { readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync, watch } from 'fs';
import { createDebug } from '../utils/debug.js';
import type {
  Skill,
  SkillsLoaderConfig,
  LoadedSkills,
  SkillEntry,
} from './types.js';

const log = createDebug('skills:loader');

const SKILL_FILE = 'SKILL.md';
const DEFAULT_BUNDLED_DIRS = [
  join(process.cwd(), 'src', 'feishu', 'skills'),
  join(process.cwd(), 'src', 'skills'),
  join(process.cwd(), '.fan_bot', 'skills'),
];

type ChangeCallback = (skills: SkillEntry[]) => void;

export class SkillsLoader {
  private config: SkillsLoaderConfig;
  private cachedSkills: LoadedSkills | null = null;
  private watchers: ReturnType<typeof watch>[] = [];
  private reloadTimeout: ReturnType<typeof setTimeout> | null = null;
  private changeCallbacks: ChangeCallback[] = [];
  private isWatching = false;

  constructor(config: SkillsLoaderConfig = {}) {
    this.config = {
      watch: false,
      watchDebounceMs: 250,
      ...config,
    };
  }

  async loadAll(): Promise<LoadedSkills> {
    const bundled = await this.loadBundled();
    const extra = await this.loadExtraDirs();

    this.cachedSkills = { bundled, extra };
    return this.cachedSkills;
  }

  getCached(): LoadedSkills | null {
    return this.cachedSkills;
  }

  getAllSkills(): Skill[] {
    if (!this.cachedSkills) {
      log.warn('Skills not loaded yet, call loadAll() first');
      return [];
    }
    return [
      ...this.cachedSkills.bundled,
      ...this.cachedSkills.extra,
    ];
  }

  getSkillEntries(): SkillEntry[] {
    return this.getAllSkills().map((skill) => ({
      name: skill.metadata.name,
      description: skill.metadata.description,
      location: skill.baseDir,
      alwaysActive: skill.metadata.alwaysActive ?? false,
    }));
  }

  onChange(callback: ChangeCallback): void {
    this.changeCallbacks.push(callback);
  }

  startWatching(): void {
    if (this.isWatching) {
      log.debug('Skills watcher already running');
      return;
    }

    const dirs = this.getWatchDirs();
    if (dirs.length === 0) {
      log.debug('No skill directories to watch');
      return;
    }

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;

      try {
        const watcher = watch(
          dir,
          { recursive: true },
          (eventType, filename) => {
            if (filename && filename.endsWith(SKILL_FILE)) {
              log.debug(`Skill file changed: ${filename} (${eventType})`);
              this.scheduleReload();
            }
          },
        );

        this.watchers.push(watcher);
        log.debug(`Watching skill directory: ${dir}`);
      } catch (error) {
        log.warn(`Failed to watch directory ${dir}: ${error}`);
      }
    }

    this.isWatching = true;
    log.info(`Started watching ${this.watchers.length} skill directories`);
  }

  stopWatching(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.isWatching = false;

    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
      this.reloadTimeout = null;
    }

    log.info('Stopped watching skill directories');
  }

  private getWatchDirs(): string[] {
    const dirs: string[] = [];

    for (const dir of DEFAULT_BUNDLED_DIRS) {
      if (existsSync(dir)) {
        dirs.push(dir);
      }
    }

    if (this.config.extraDirs) {
      for (const dir of this.config.extraDirs) {
        const resolved = resolve(dir);
        if (existsSync(resolved) && !dirs.includes(resolved)) {
          dirs.push(resolved);
        }
      }
    }

    return dirs;
  }

  private scheduleReload(): void {
    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
    }

    const debounceMs = this.config.watchDebounceMs ?? 250;

    this.reloadTimeout = setTimeout(async () => {
      try {
        await this.loadAll();
        const entries = this.getSkillEntries();
        log.info(`Skills reloaded: ${entries.length} skills available`);

        for (const callback of this.changeCallbacks) {
          callback(entries);
        }
      } catch (error) {
        log.error(`Failed to reload skills: ${error}`);
      }
    }, debounceMs);
  }

  async loadBundled(): Promise<Skill[]> {
    const skills: Skill[] = [];

    for (const dir of DEFAULT_BUNDLED_DIRS) {
      if (existsSync(dir)) {
        const loaded = await this.loadSkillsFromDir(dir, 'bundled');
        skills.push(...loaded);
        log.debug(`Loaded ${loaded.length} bundled skills from ${dir}`);
      }
    }

    return this.deduplicateSkills(skills);
  }

  async loadExtraDirs(): Promise<Skill[]> {
    if (!this.config.extraDirs || this.config.extraDirs.length === 0) {
      return [];
    }

    const skills: Skill[] = [];
    for (const dir of this.config.extraDirs) {
      const resolved = resolve(dir);
      if (existsSync(resolved)) {
        const loaded = await this.loadSkillsFromDir(resolved, 'extra');
        skills.push(...loaded);
        log.debug(`Loaded ${loaded.length} extra skills from ${resolved}`);
      } else {
        log.warn(`Extra skills directory does not exist: ${resolved}`);
      }
    }

    return skills;
  }

  private async loadSkillsFromDir(
    rootDir: string,
    location: 'bundled' | 'extra',
  ): Promise<Skill[]> {
    const skills: Skill[] = [];

    try {
      const entries = await readdir(rootDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = join(rootDir, entry.name);
        const skillFile = join(skillDir, SKILL_FILE);

        if (!existsSync(skillFile)) continue;

        try {
          const content = await readFile(skillFile, 'utf-8');
          const skill = this.parseSkill(content, skillDir, location);
          if (skill) {
            skills.push(skill);
          }
        } catch (error) {
          log.warn(`Failed to load skill from ${skillFile}: ${error}`);
        }
      }
    } catch (error) {
      log.warn(`Failed to read skills directory ${rootDir}: ${error}`);
    }

    return skills;
  }

  private parseSkill(
    content: string,
    baseDir: string,
    location: 'bundled' | 'extra',
  ): Skill | null {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

    if (!frontmatterMatch) {
      log.warn(`Skill at ${baseDir} missing frontmatter`);
      return null;
    }

    const metadata = this.parseFrontmatter(frontmatterMatch[1]);

    const name = String(metadata.name || '');
    const description = String(metadata.description || '');

    if (!name || !description) {
      log.warn(
        `Skill at ${baseDir} missing name or description in frontmatter`,
      );
      return null;
    }

    return {
      metadata: {
        name,
        description,
        alwaysActive: metadata.alwaysActive === true,
        disableModelInvocation: metadata.disableModelInvocation === true,
        userInvocable: metadata.userInvocable !== false,
      },
      content,
      baseDir,
    };
  }

  private parseFrontmatter(yaml: string): Record<string, string | boolean> {
    const result: Record<string, string | boolean> = {};
    const lines = yaml.split('\n');

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();

      if (value === '') {
        result[key] = true;
      } else if (value === 'true') {
        result[key] = true;
      } else if (value === 'false') {
        result[key] = false;
      } else {
        result[key] = value.replace(/^["']|["']$/g, '');
      }
    }

    return result;
  }

  private deduplicateSkills(skills: Skill[]): Skill[] {
    const seen = new Map<string, Skill>();

    for (const skill of skills) {
      const existing = seen.get(skill.metadata.name);
      if (!existing) {
        seen.set(skill.metadata.name, skill);
      }
    }

    return Array.from(seen.values());
  }
}

function formatSkillsForPrompt(entries: SkillEntry[]): string {
  if (entries.length === 0) {
    return '';
  }

  const baseOverhead = 195;
  const perSkillOverhead = 97;

  let totalLength = baseOverhead;

  const lines: string[] = [];
  lines.push('<skills>');

  for (const entry of entries) {
    const nameEscaped = xmlEscape(entry.name);
    const descEscaped = xmlEscape(entry.description);
    const locEscaped = xmlEscape(entry.location);

    lines.push('  <skill>');
    lines.push(`    <name>${nameEscaped}</name>`);
    lines.push(`    <description>${descEscaped}</description>`);
    lines.push(`    <location>${locEscaped}</location>`);
    lines.push('  </skill>');

    totalLength +=
      perSkillOverhead +
      nameEscaped.length +
      descEscaped.length +
      locEscaped.length;
  }

  lines.push('</skills>');

  const formula = `~${Math.round(totalLength / 4)} tokens`;
  lines.push(`<!-- ${entries.length} skills, ${formula} -->`);

  return lines.join('\n');
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export { xmlEscape, formatSkillsForPrompt };

export function getSkillContent(
  skills: Skill[],
  skillName: string,
): string | null {
  const skill = skills.find((s) => s.metadata.name === skillName);
  return skill?.content ?? null;
}

const globalLoader = new SkillsLoader();

export function getGlobalLoader(): SkillsLoader {
  return globalLoader;
}

export async function loadAllSkills(): Promise<LoadedSkills> {
  return globalLoader.loadAll();
}

export function getSkillEntries(): SkillEntry[] {
  return globalLoader.getSkillEntries();
}

// ─── Skill Tools Auto-Loader ────────────────────────────────────────────────

import type { Tool } from '../tools/types.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const SKILL_TOOLS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'tools',
);

/**
 * 扫描 src/skills/tools/{skill-name}/ 目录，自动加载所有 Skill 关联工具。
 *
 * 约定：每个子目录导出 `tools: Tool[]`。
 */
export async function loadSkillTools(): Promise<Tool[]> {
  const allTools: Tool[] = [];

  if (!existsSync(SKILL_TOOLS_DIR)) {
    log.debug('No skill tools directory found');
    return allTools;
  }

  try {
    const entries = await readdir(SKILL_TOOLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const indexPath = join(SKILL_TOOLS_DIR, entry.name, 'index.js');
      if (!existsSync(indexPath)) continue;

      try {
        const mod = (await import(indexPath)) as { tools?: Tool[] };
        if (Array.isArray(mod.tools)) {
          allTools.push(...mod.tools);
          log.info(
            `Loaded ${mod.tools.length} tools from skill "${entry.name}"`,
          );
        } else {
          log.warn(
            `Skill tools module "${entry.name}" does not export a "tools" array`,
          );
        }
      } catch (error) {
        log.error(`Failed to load skill tools from "${entry.name}": ${error}`);
      }
    }
  } catch (error) {
    log.error(`Failed to scan skill tools directory: ${error}`);
  }

  return allTools;
}
