import { describe, it, expect, vi } from 'vitest';
import {
  extractUsedSkills,
  detectSkillIssueSignals,
  evaluateForImprovement,
} from './extractor.js';
import type { Message } from '../llm/types.js';

// Mock loader
vi.mock('./loader.js', () => ({
  getGlobalLoader: () => ({
    getAllSkills: () => [
      {
        metadata: { name: 'deploy-workflow', version: 2 },
        content: '---\nname: deploy-workflow\nversion: 2\n---\n\n# deploy\n\nSteps here.',
        baseDir: '/fake/skills/deploy-workflow',
      },
    ],
    loadAll: vi.fn(),
  }),
}));

describe('extractUsedSkills', () => {
  it('应该从 Skill activate 调用中提取技能名', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: '1',
            name: 'Skill',
            input: { action: 'activate', skill_name: 'deploy-workflow' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: '2',
            name: 'bash',
            input: { command: 'ls' },
          },
        ],
      },
    ];

    expect(extractUsedSkills(messages)).toEqual(['deploy-workflow']);
  });

  it('应该忽略非 activate 的 Skill 调用', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: '1',
            name: 'Skill',
            input: { action: 'list_pending' },
          },
        ],
      },
    ];

    expect(extractUsedSkills(messages)).toEqual([]);
  });

  it('应该去重', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: '1',
            name: 'Skill',
            input: { action: 'activate', skill_name: 'deploy-workflow' },
          },
          {
            type: 'tool_use',
            id: '2',
            name: 'Skill',
            input: { skill_name: 'deploy-workflow' },
          },
        ],
      },
    ];

    expect(extractUsedSkills(messages)).toEqual(['deploy-workflow']);
  });
});

describe('detectSkillIssueSignals', () => {
  it('应该检测 tool_result 错误', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: 'Error: failed', is_error: true }],
      },
    ];

    expect(detectSkillIssueSignals(messages)).toBe(true);
  });

  it('应该检测用户纠正性语言', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: '不对，应该是用另一个命令' }],
      },
    ];

    expect(detectSkillIssueSignals(messages)).toBe(true);
  });

  it('正常对话不应触发', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: '帮我部署一下' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '已完成部署' }],
      },
    ];

    expect(detectSkillIssueSignals(messages)).toBe(false);
  });
});

describe('evaluateForImprovement', () => {
  it('没有使用技能时应直接返回 null', async () => {
    const mockLLM = { chat: vi.fn() };
    const result = await evaluateForImprovement([], [], mockLLM as never);
    expect(result).toBeNull();
    expect(mockLLM.chat).not.toHaveBeenCalled();
  });

  it('无异常信号时不应调用 LLM', async () => {
    const mockLLM = { chat: vi.fn() };
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '帮我部署' }] },
      { role: 'assistant', content: [{ type: 'text', text: '完成' }] },
    ];

    const result = await evaluateForImprovement(messages, ['deploy-workflow'], mockLLM as never);
    expect(result).toBeNull();
    expect(mockLLM.chat).not.toHaveBeenCalled();
  });

  it('有异常信号时应调用 LLM 评估', async () => {
    const mockLLM = {
      chat: vi.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            needsImprovement: true,
            skillName: 'deploy-workflow',
            reason: 'Step 3 uses wrong command',
            suggestedFeedback: 'Change kubectl apply to kubectl rollout',
            feedbackType: 'bug',
          }),
        }],
      }),
    };

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '不对，这个命令错了' }] },
    ];

    const result = await evaluateForImprovement(messages, ['deploy-workflow'], mockLLM as never);
    expect(result).not.toBeNull();
    expect(result!.skillName).toBe('deploy-workflow');
    expect(result!.feedbackType).toBe('bug');
    expect(mockLLM.chat).toHaveBeenCalledTimes(1);
  });
});
