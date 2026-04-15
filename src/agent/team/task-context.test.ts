import { describe, it, expect } from 'vitest';
import {
  buildTaskContext,
  formatTaskContextPrompt,
  type TaskContext,
} from './task-context.js';
import type { TeamTask } from './types.js';

function createTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-1',
    description: 'Test task description',
    assignee: null,
    status: 'pending',
    ...overrides,
  };
}

describe('buildTaskContext', () => {
  it('should build context with no dependencies', () => {
    const task = createTask({ id: 'task-1', description: 'Write code' });

    const ctx = buildTaskContext(task, [task], 'Build a web app');

    expect(ctx.taskId).toBe('task-1');
    expect(ctx.objective).toBe('Write code');
    expect(ctx.sharedContext).toBe('Build a web app');
    expect(ctx.dependencyResults).toEqual([]);
  });

  it('should include dependency results', () => {
    const depTask = createTask({
      id: 'dep-1',
      name: 'Research',
      description: 'Research best practices',
      status: 'completed',
      result: 'Found 5 best practices...',
    });
    const task = createTask({
      id: 'task-1',
      description: 'Implement based on research',
      dependencies: ['dep-1'],
    });

    const ctx = buildTaskContext(task, [depTask, task], 'Build a web app');

    expect(ctx.dependencyResults).toHaveLength(1);
    expect(ctx.dependencyResults[0].taskName).toBe('Research');
    expect(ctx.dependencyResults[0].result).toBe('Found 5 best practices...');
  });

  it('should skip incomplete dependencies', () => {
    const depTask = createTask({
      id: 'dep-1',
      name: 'Research',
      status: 'pending',
    });
    const task = createTask({
      id: 'task-1',
      dependencies: ['dep-1'],
    });

    const ctx = buildTaskContext(task, [depTask, task], 'goal');

    expect(ctx.dependencyResults).toHaveLength(0);
  });

  it('should truncate long dependency results', () => {
    const longResult = 'x'.repeat(3000);
    const depTask = createTask({
      id: 'dep-1',
      name: 'Research',
      status: 'completed',
      result: longResult,
    });
    const task = createTask({
      id: 'task-1',
      dependencies: ['dep-1'],
    });

    const ctx = buildTaskContext(task, [depTask, task], 'goal');

    expect(ctx.dependencyResults[0].result.length).toBeLessThan(longResult.length);
    expect(ctx.dependencyResults[0].result).toContain('[... truncated ...]');
  });
});

describe('formatTaskContextPrompt', () => {
  it('should format a complete context into prompt', () => {
    const ctx: TaskContext = {
      taskId: 'task-1',
      objective: 'Write unit tests',
      sharedContext: 'Build a test suite for the auth module',
      dependencyResults: [
        { taskName: 'Code Review', result: 'Module has 5 functions' },
      ],
      allowedTools: ['read_file', 'write_file'],
    };

    const prompt = formatTaskContextPrompt(ctx);

    expect(prompt).toContain('## Your Task');
    expect(prompt).toContain('Write unit tests');
    expect(prompt).toContain('## Overall Goal');
    expect(prompt).toContain('Build a test suite');
    expect(prompt).toContain('## Results from Previous Tasks');
    expect(prompt).toContain('Code Review');
    expect(prompt).toContain('Module has 5 functions');
    expect(prompt).toContain('## Instructions');
  });

  it('should omit sections when empty', () => {
    const ctx: TaskContext = {
      taskId: 'task-1',
      objective: 'Simple task',
      sharedContext: '',
      dependencyResults: [],
      allowedTools: [],
    };

    const prompt = formatTaskContextPrompt(ctx);

    expect(prompt).toContain('## Your Task');
    expect(prompt).not.toContain('## Overall Goal');
    expect(prompt).not.toContain('## Results from Previous Tasks');
    expect(prompt).toContain('## Instructions');
  });
});
