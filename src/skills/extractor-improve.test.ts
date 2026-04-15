import { describe, it, expect, vi, beforeEach } from 'vitest';
import { improveSkill } from './extractor.js';
import type { SkillImprovementFeedback } from './types.js';

// Mock 文件系统
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

// Mock loader
const mockSkills = [
  {
    metadata: { name: 'test-skill', description: 'Test', version: 2, source: 'auto' as const },
    content: '---\nname: test-skill\ndescription: Test\nversion: 2\nsource: auto\n---\n\n# test-skill\n\nDo something.',
    baseDir: '/fake/.fan_bot/skills/test-skill',
  },
];

vi.mock('./loader.js', () => ({
  getGlobalLoader: () => ({
    getAllSkills: () => mockSkills,
    loadAll: vi.fn().mockResolvedValue({ bundled: mockSkills, extra: [] }),
  }),
}));

describe('improveSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应该拒绝不存在的技能', async () => {
    const mockLLM = { chat: vi.fn() };

    await expect(
      improveSkill('nonexistent', { type: 'bug', feedback: 'fix it' }, mockLLM as never),
    ).rejects.toThrow('Skill "nonexistent" not found');
  });

  it('应该备份旧版本并写入新版本', async () => {
    const { readFile, writeFile, copyFile } = await import('fs/promises');
    const mockedReadFile = vi.mocked(readFile);
    const mockedWriteFile = vi.mocked(writeFile);
    const mockedCopyFile = vi.mocked(copyFile);

    const oldContent =
      '---\nname: test-skill\ndescription: Test\nversion: 2\nsource: auto\n---\n\n# test-skill\n\nOld content.';

    mockedReadFile.mockResolvedValue(oldContent as never);

    const newLLMContent =
      '---\nname: test-skill\ndescription: Test improved\nversion: 3\nsource: auto\n---\n\n# test-skill\n\nNew improved content.\n\n## Changelog\n- v3: Fixed bug per user feedback';

    const mockLLM = {
      chat: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: newLLMContent }],
      }),
    };

    const feedback: SkillImprovementFeedback = {
      type: 'bug',
      feedback: 'step 3 is wrong',
    };

    const result = await improveSkill('test-skill', feedback, mockLLM as never);

    expect(result.name).toBe('test-skill');
    expect(result.previousVersion).toBe(2);
    expect(result.newVersion).toBe(3);
    expect(result.changeSummary).toContain('bug');

    // 验证备份被创建
    expect(mockedCopyFile).toHaveBeenCalledWith(
      '/fake/.fan_bot/skills/test-skill/SKILL.md',
      '/fake/.fan_bot/skills/test-skill/versions/SKILL.v2.md',
    );

    // 验证新文件被写入
    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/fake/.fan_bot/skills/test-skill/SKILL.md',
      expect.stringContaining('version: 3'),
    );
  });

  it('应该在 LLM prompt 中包含对话上下文', async () => {
    const { readFile } = await import('fs/promises');
    vi.mocked(readFile).mockResolvedValue(
      '---\nname: test-skill\ndescription: Test\nversion: 1\nsource: auto\n---\n\nContent.' as never,
    );

    const mockLLM = {
      chat: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '---\nname: test-skill\ndescription: Test\nversion: 2\nsource: auto\n---\n\nImproved.' }],
      }),
    };

    const feedback: SkillImprovementFeedback = {
      type: 'enhancement',
      feedback: 'add error handling',
      conversationContext: 'User tried X but got error Y',
    };

    await improveSkill('test-skill', feedback, mockLLM as never);

    // 验证 LLM prompt 包含对话上下文
    const promptArg = mockLLM.chat.mock.calls[0][0][0].content[0];
    expect(promptArg).toHaveProperty('text');
    expect((promptArg as { text: string }).text).toContain('User tried X but got error Y');
  });
});
