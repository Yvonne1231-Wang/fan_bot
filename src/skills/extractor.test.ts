import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  countToolUses,
  hasExplicitSkillRequest,
  extractToolNames,
  evaluateForSkill,
  savePendingSkill,
  listPendingSkills,
  confirmPendingSkill,
  rejectPendingSkill,
  cleanupExpiredPending,
} from './extractor.js';
import type { Message } from '../llm/types.js';
import type { PendingSkill } from './extractor.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Helpers ────────────────────────────────────────────────────────────────

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

function toolMsg(toolName: string, input: Record<string, unknown> = {}): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: `Running ${toolName}` },
      { type: 'tool_use', id: `tool_${toolName}`, name: toolName, input },
    ],
  };
}

function toolResultMsg(toolId: string, result: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolId, content: result }],
  };
}

// ─── countToolUses ──────────────────────────────────────────────────────────

describe('skills/extractor countToolUses', () => {
  it('counts zero for no tool_use blocks', () => {
    const msgs: Message[] = [
      textMsg('user', 'hello'),
      textMsg('assistant', 'hi'),
    ];
    expect(countToolUses(msgs)).toBe(0);
  });

  it('counts tool_use blocks across messages', () => {
    const msgs: Message[] = [
      textMsg('user', 'do something'),
      toolMsg('shell'),
      toolResultMsg('tool_shell', 'output'),
      toolMsg('read_file'),
      toolResultMsg('tool_read_file', 'content'),
      toolMsg('write_file'),
    ];
    expect(countToolUses(msgs)).toBe(3);
  });

  it('counts multiple tool_use in one message', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'a', input: {} },
          { type: 'tool_use', id: 't2', name: 'b', input: {} },
        ],
      },
    ];
    expect(countToolUses(msgs)).toBe(2);
  });
});

// ─── hasExplicitSkillRequest ────────────────────────────────────────────────

describe('skills/extractor hasExplicitSkillRequest', () => {
  it('detects Chinese skill request', () => {
    expect(hasExplicitSkillRequest('以后都这样做')).toBe(true);
    expect(hasExplicitSkillRequest('把这个保存为技能')).toBe(true);
    expect(hasExplicitSkillRequest('请记住这个流程')).toBe(true);
  });

  it('detects English skill request', () => {
    expect(hasExplicitSkillRequest('save as skill')).toBe(true);
    expect(hasExplicitSkillRequest('create a skill for this')).toBe(true);
  });

  it('returns false for normal prompts', () => {
    expect(hasExplicitSkillRequest('帮我写个函数')).toBe(false);
    expect(hasExplicitSkillRequest('what is TypeScript')).toBe(false);
  });
});

// ─── extractToolNames ───────────────────────────────────────────────────────

describe('skills/extractor extractToolNames', () => {
  it('extracts unique tool names', () => {
    const msgs: Message[] = [
      toolMsg('shell'),
      toolMsg('read_file'),
      toolMsg('shell'), // duplicate
      toolMsg('write_file'),
    ];
    const names = extractToolNames(msgs);
    expect(names).toEqual(expect.arrayContaining(['shell', 'read_file', 'write_file']));
    expect(names.length).toBe(3);
  });

  it('returns empty for no tools', () => {
    expect(extractToolNames([textMsg('user', 'hi')])).toEqual([]);
  });
});

// ─── evaluateForSkill ───────────────────────────────────────────────────────

describe('skills/extractor evaluateForSkill', () => {
  it('returns null when tool count below threshold', async () => {
    const msgs = [textMsg('user', 'hi'), toolMsg('shell')];
    const mockLLM = { chat: vi.fn() };
    const result = await evaluateForSkill(msgs, mockLLM as never, {
      minToolUses: 3,
      requireConfirmation: true,
      pendingExpireDays: 7,
    });
    expect(result).toBeNull();
    expect(mockLLM.chat).not.toHaveBeenCalled();
  });

  it('calls LLM and returns candidate when worthy', async () => {
    const msgs = [
      textMsg('user', 'deploy the app'),
      toolMsg('shell'),
      toolMsg('read_file'),
      toolMsg('write_file'),
    ];
    const mockLLM = {
      chat: vi.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            isSkillWorthy: true,
            name: 'auto-deploy',
            description: 'Automated deployment workflow',
            reason: 'Multi-step deploy pattern',
            confidence: 0.85,
            toolNames: ['shell', 'read_file', 'write_file'],
          }),
        }],
      }),
    };

    const result = await evaluateForSkill(msgs, mockLLM as never, {
      minToolUses: 3,
      requireConfirmation: true,
      pendingExpireDays: 7,
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe('auto-deploy');
    expect(result!.confidence).toBe(0.85);
  });

  it('returns null when LLM says not worthy', async () => {
    const msgs = [
      textMsg('user', 'fix a typo'),
      toolMsg('shell'),
      toolMsg('read_file'),
      toolMsg('write_file'),
    ];
    const mockLLM = {
      chat: vi.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            isSkillWorthy: false,
            name: 'typo-fix',
            description: 'One-off fix',
            reason: 'Single-use task',
            confidence: 0.2,
            toolNames: [],
          }),
        }],
      }),
    };

    const result = await evaluateForSkill(msgs, mockLLM as never);
    expect(result).toBeNull();
  });
});

// ─── Pending Skills ─────────────────────────────────────────────────────────

const PENDING_DIR = join(process.cwd(), '.fan_bot', 'pending_skills');
const SKILLS_DIR = join(process.cwd(), '.fan_bot', 'skills');

describe('skills/extractor pending skills', () => {
  beforeEach(() => {
    // Clean up test dirs
    if (existsSync(PENDING_DIR)) rmSync(PENDING_DIR, { recursive: true });
    // Don't clean the entire skills dir (has real skills), only our test skill
  });

  afterEach(() => {
    if (existsSync(PENDING_DIR)) rmSync(PENDING_DIR, { recursive: true });
    const testSkillDir = join(SKILLS_DIR, 'test-skill');
    if (existsSync(testSkillDir)) rmSync(testSkillDir, { recursive: true });
  });

  const testPending: PendingSkill = {
    candidate: {
      name: 'test-skill',
      description: 'A test skill',
      reason: 'Testing',
      confidence: 0.9,
      toolNames: ['shell'],
    },
    draft: {
      name: 'test-skill',
      content: '---\nname: test-skill\ndescription: A test skill\nsource: auto\nversion: 1\n---\n\n# test-skill\n\nTest instructions.',
    },
    createdAt: Date.now(),
  };

  it('saves and lists pending skills', async () => {
    await savePendingSkill(testPending);
    const pending = await listPendingSkills();
    expect(pending.length).toBe(1);
    expect(pending[0].candidate.name).toBe('test-skill');
  });

  it('confirms a pending skill (writes SKILL.md)', async () => {
    await savePendingSkill(testPending);
    const ok = await confirmPendingSkill('test-skill');
    expect(ok).toBe(true);

    // SKILL.md should exist
    const skillMd = join(SKILLS_DIR, 'test-skill', 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);

    // Pending should be removed
    const pending = await listPendingSkills();
    expect(pending.length).toBe(0);
  });

  it('rejects a pending skill', async () => {
    await savePendingSkill(testPending);
    const ok = await rejectPendingSkill('test-skill');
    expect(ok).toBe(true);

    const pending = await listPendingSkills();
    expect(pending.length).toBe(0);
  });

  it('returns false for non-existent pending skill', async () => {
    expect(await confirmPendingSkill('nope')).toBe(false);
    expect(await rejectPendingSkill('nope')).toBe(false);
  });

  it('cleans up expired pending skills', async () => {
    const expiredPending: PendingSkill = {
      ...testPending,
      createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    };
    await savePendingSkill(expiredPending);

    const cleaned = await cleanupExpiredPending(7);
    expect(cleaned).toBe(1);

    const pending = await listPendingSkills();
    expect(pending.length).toBe(0);
  });

  it('does not clean recent pending skills', async () => {
    await savePendingSkill(testPending); // just created
    const cleaned = await cleanupExpiredPending(7);
    expect(cleaned).toBe(0);

    const pending = await listPendingSkills();
    expect(pending.length).toBe(1);
  });
});
