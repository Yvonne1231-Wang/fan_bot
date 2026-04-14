import { describe, it, expect } from 'vitest';
import {
  mergeProfileUpdate,
  formatProfileForPrompt,
  type UserPreferences,
  type ProfileUpdate,
} from './profile.js';

function createTestProfile(
  overrides: Partial<UserPreferences> = {},
): UserPreferences {
  return {
    userId: 'test-user',
    updatedAt: Date.now(),
    techPreferences: [],
    communicationStyle: [],
    activeProjects: [],
    decisions: [],
    notes: [],
    ...overrides,
  };
}

describe('mergeProfileUpdate', () => {
  it('should add new tech preferences without duplicates', () => {
    const existing = createTestProfile({
      techPreferences: ['TypeScript', 'React'],
    });
    const update: ProfileUpdate = {
      techPreferences: ['React', 'Vue', 'Node.js'],
    };

    const result = mergeProfileUpdate(existing, update);

    expect(result.techPreferences).toEqual(['TypeScript', 'React', 'Vue', 'Node.js']);
  });

  it('should add new communication styles', () => {
    const existing = createTestProfile({
      communicationStyle: ['concise answers'],
    });
    const update: ProfileUpdate = {
      communicationStyle: ['prefers Chinese'],
    };

    const result = mergeProfileUpdate(existing, update);

    expect(result.communicationStyle).toEqual([
      'concise answers',
      'prefers Chinese',
    ]);
  });

  it('should update existing projects by name', () => {
    const existing = createTestProfile({
      activeProjects: [
        { name: 'fan_bot', description: 'old description' },
        { name: 'other', description: 'other project' },
      ],
    });
    const update: ProfileUpdate = {
      activeProjects: [
        { name: 'fan_bot', description: 'AI assistant framework' },
      ],
    };

    const result = mergeProfileUpdate(existing, update);

    expect(result.activeProjects).toHaveLength(2);
    expect(result.activeProjects.find((p) => p.name === 'fan_bot')?.description)
      .toBe('AI assistant framework');
    expect(result.activeProjects.find((p) => p.name === 'other')?.description)
      .toBe('other project');
  });

  it('should override decisions with same topic', () => {
    const existing = createTestProfile({
      decisions: [
        { topic: 'framework', preference: 'React', date: 1000 },
        { topic: 'language', preference: 'TypeScript', date: 1000 },
      ],
    });
    const update: ProfileUpdate = {
      decisions: [
        { topic: 'framework', preference: 'Vue', date: 2000 },
      ],
    };

    const result = mergeProfileUpdate(existing, update);

    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.find((d) => d.topic === 'framework')?.preference)
      .toBe('Vue');
    expect(result.decisions.find((d) => d.topic === 'language')?.preference)
      .toBe('TypeScript');
  });

  it('should handle empty update gracefully', () => {
    const existing = createTestProfile({
      techPreferences: ['TypeScript'],
      notes: ['works remotely'],
    });
    const update: ProfileUpdate = {};

    const result = mergeProfileUpdate(existing, update);

    expect(result.techPreferences).toEqual(['TypeScript']);
    expect(result.notes).toEqual(['works remotely']);
  });

  it('should update the timestamp', () => {
    const existing = createTestProfile({ updatedAt: 1000 });
    const update: ProfileUpdate = { notes: ['new note'] };

    const result = mergeProfileUpdate(existing, update);

    expect(result.updatedAt).toBeGreaterThan(1000);
  });
});

describe('formatProfileForPrompt', () => {
  it('should return empty string for empty profile', () => {
    const profile = createTestProfile();

    const result = formatProfileForPrompt(profile);

    expect(result).toBe('');
  });

  it('should format tech preferences', () => {
    const profile = createTestProfile({
      techPreferences: ['TypeScript', 'Vim'],
    });

    const result = formatProfileForPrompt(profile);

    expect(result).toContain('## User Profile');
    expect(result).toContain('### Tech Preferences');
    expect(result).toContain('- TypeScript');
    expect(result).toContain('- Vim');
  });

  it('should format active projects with path', () => {
    const profile = createTestProfile({
      activeProjects: [
        { name: 'fan_bot', path: '/home/user/fan_bot', description: 'AI assistant' },
      ],
    });

    const result = formatProfileForPrompt(profile);

    expect(result).toContain('**fan_bot**');
    expect(result).toContain('(/home/user/fan_bot)');
    expect(result).toContain('AI assistant');
  });

  it('should only show last 10 decisions', () => {
    const decisions = Array.from({ length: 15 }, (_, i) => ({
      topic: `topic-${i}`,
      preference: `pref-${i}`,
      date: i,
    }));
    const profile = createTestProfile({ decisions });

    const result = formatProfileForPrompt(profile);

    // 应该包含 topic-5 到 topic-14（最后10条）
    expect(result).toContain('topic-5');
    expect(result).toContain('topic-14');
    expect(result).not.toContain('topic-4');
  });

  it('should truncate if exceeding max length', () => {
    const profile = createTestProfile({
      notes: Array.from({ length: 200 }, (_, i) => `This is a very long note number ${i} with lots of text to fill up space`),
    });

    const result = formatProfileForPrompt(profile);

    expect(result.length).toBeLessThanOrEqual(2100); // 2000 + truncation message
    expect(result).toContain('[Profile truncated]');
  });
});
