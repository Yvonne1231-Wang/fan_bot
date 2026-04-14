import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { skillTool } from './skill.js';
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

// ─── Test directories ──────────────────────────────────────────────────────

const PENDING_DIR = join(process.cwd(), '.fan_bot', 'pending_skills');
const AUTO_SKILLS_DIR = join(process.cwd(), '.fan_bot', 'skills');

// Use unique prefix to avoid collision with extractor.test.ts
const PREFIX = 'sktool-';

function createPendingSkill(name: string, confidence = 0.85) {
  if (!existsSync(PENDING_DIR)) {
    mkdirSync(PENDING_DIR, { recursive: true });
  }
  const pending = {
    candidate: {
      name,
      description: `Auto-extracted ${name} skill`,
      reason: 'Repeated pattern detected',
      confidence,
      toolNames: ['shell', 'files'],
    },
    draft: {
      name,
      content: `---\nname: ${name}\ndescription: Test skill\nsource: auto\nversion: 1\n---\n\n# ${name}\n\nTest skill content.`,
    },
    createdAt: Date.now(),
  };
  writeFileSync(join(PENDING_DIR, `${name}.json`), JSON.stringify(pending, null, 2));
}

function cleanOwnFiles() {
  if (!existsSync(PENDING_DIR)) return;
  const files = readdirSync(PENDING_DIR);
  for (const f of files) {
    if (f.startsWith(PREFIX)) {
      rmSync(join(PENDING_DIR, f), { force: true });
    }
  }
  const autoDir = join(AUTO_SKILLS_DIR, `${PREFIX}confirm`);
  if (existsSync(autoDir)) rmSync(autoDir, { recursive: true });
}

// ─── Cleanup (only own files, not entire directory) ────────────────────────

beforeEach(() => { cleanOwnFiles(); });
afterEach(() => { cleanOwnFiles(); });

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Skill tool - activate', () => {
  it('should return error when skill_name is missing for activate', async () => {
    const result = await skillTool.handler({});
    expect(result).toContain('skill_name is required');
  });

  it('should return error when skill not found', async () => {
    const result = await skillTool.handler({ skill_name: 'nonexistent-skill-xyz' });
    expect(result).toContain('not found');
  });
});

describe('Skill tool - list_pending', () => {
  it('should list pending skills with details', async () => {
    createPendingSkill(`${PREFIX}deploy`);
    createPendingSkill(`${PREFIX}lint`);

    const result = await skillTool.handler({ action: 'list_pending' });
    // Don't check exact count (parallel tests may add more), just check our entries exist
    expect(result).toContain('Pending skills');
    expect(result).toContain(`${PREFIX}deploy`);
    expect(result).toContain(`${PREFIX}lint`);
    expect(result).toContain('0.85');
  });
});

describe('Skill tool - confirm', () => {
  it('should require skill_name', async () => {
    const result = await skillTool.handler({ action: 'confirm' });
    expect(result).toContain('skill_name is required');
  });

  it('should return error for non-existent pending skill', async () => {
    const result = await skillTool.handler({ action: 'confirm', skill_name: 'ghost' });
    expect(result).toContain('not found');
  });

  it('should confirm and install a pending skill', async () => {
    createPendingSkill(`${PREFIX}confirm`);

    const result = await skillTool.handler({ action: 'confirm', skill_name: `${PREFIX}confirm` });
    expect(result).toContain('confirmed and installed');

    // Pending file should be removed
    expect(existsSync(join(PENDING_DIR, `${PREFIX}confirm.json`))).toBe(false);

    // SKILL.md should exist in auto skills dir
    expect(existsSync(join(AUTO_SKILLS_DIR, `${PREFIX}confirm`, 'SKILL.md'))).toBe(true);
  });
});

describe('Skill tool - reject', () => {
  it('should require skill_name', async () => {
    const result = await skillTool.handler({ action: 'reject' });
    expect(result).toContain('skill_name is required');
  });

  it('should return error for non-existent pending skill', async () => {
    const result = await skillTool.handler({ action: 'reject', skill_name: 'ghost' });
    expect(result).toContain('not found');
  });

  it('should reject and remove a pending skill', async () => {
    createPendingSkill(`${PREFIX}unwanted`);

    const result = await skillTool.handler({ action: 'reject', skill_name: `${PREFIX}unwanted` });
    expect(result).toContain('rejected and removed');

    expect(existsSync(join(PENDING_DIR, `${PREFIX}unwanted.json`))).toBe(false);
  });
});
