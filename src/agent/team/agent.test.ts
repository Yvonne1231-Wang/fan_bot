import { describe, it, expect } from 'vitest';
import type { AgentExecutionResult } from './types.js';

describe('executeTasksParallel 末尾补偿逻辑：按 taskId 追踪而非 agentType', () => {
  it('同类型多任务：按 taskId 区分已完成与未完成', () => {
    const taskIds = ['t1', 't2', 't3'];

    const results: AgentExecutionResult[] = [
      { taskId: 't1', agentType: 'researcher', success: true, output: 'r1' },
      { taskId: 't2', agentType: 'researcher', success: true, output: 'r2' },
    ];

    const completedTaskIds = new Set(
      results.map((r) => r.taskId).filter((id): id is string => !!id),
    );
    const remaining = taskIds.filter((id) => !completedTaskIds.has(id));

    expect(remaining).toEqual(['t3']);
  });

  it('旧逻辑（agentType 匹配）在同类型多任务下会错配', () => {
    const tasks = [
      { id: 't1', agentType: 'researcher' },
      { id: 't2', agentType: 'researcher' },
      { id: 't3', agentType: 'researcher' },
    ];

    const results: AgentExecutionResult[] = [
      { taskId: 't1', agentType: 'researcher', success: true, output: 'r1' },
    ];

    const oldLogicRemaining = tasks.filter(
      (t) => !results.some((r) => t.agentType === r.agentType),
    );
    expect(oldLogicRemaining.length).toBe(0);

    const newLogicRemaining = tasks.filter(
      (t) =>
        !new Set(
          results.map((r) => r.taskId).filter((id): id is string => !!id),
        ).has(t.id),
    );
    expect(newLogicRemaining.length).toBe(2);
    expect(newLogicRemaining.map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('不同类型任务：新逻辑同样正确', () => {
    const taskIds = ['t1', 't2', 't3'];

    const results: AgentExecutionResult[] = [
      { taskId: 't1', agentType: 'coder', success: true, output: 'r1' },
      { taskId: 't2', agentType: 'researcher', success: true, output: 'r2' },
    ];

    const completedTaskIds = new Set(
      results.map((r) => r.taskId).filter((id): id is string => !!id),
    );
    const remaining = taskIds.filter((id) => !completedTaskIds.has(id));

    expect(remaining).toEqual(['t3']);
  });
});
