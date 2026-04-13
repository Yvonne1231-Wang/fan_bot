import type { Tool } from './types.js';
import { getMemory } from '../memory/index.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('tools:memory');

export const memoryListTool: Tool = {
  schema: {
    name: 'memory_list',
    description:
      '列出当前用户的所有记忆。当用户想查看、检查或管理已存储的记忆时使用此工具。',
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['user', 'agent', 'global'],
          description: '按作用域过滤记忆，不填则返回全部',
        },
        keyword: {
          type: 'string',
          description: '按关键词过滤记忆（匹配 key 或 value），不填则不过滤',
        },
      },
      required: [],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const memory = getMemory();
    const scope = input.scope as 'user' | 'agent' | 'global' | undefined;
    const keyword = input.keyword as string | undefined;

    const records = await memory.listAll(scope);
    const filtered = keyword
      ? records.filter((r) => {
          const lk = r.key.toLowerCase();
          const lv = r.value.toLowerCase();
          const kw = keyword.toLowerCase();
          return lk.includes(kw) || lv.includes(kw);
        })
      : records;

    if (filtered.length === 0) {
      return '没有找到匹配的记忆。';
    }

    const lines = filtered.map(
      (r) => `- [${r.key}]: ${r.value} (id: ${r.id}, scope: ${r.scope})`,
    );
    return `共 ${filtered.length} 条记忆：\n${lines.join('\n')}`;
  },
};

export const memoryDeleteTool: Tool = {
  schema: {
    name: 'memory_delete',
    description:
      '⚠️ 危险操作：永久删除指定 key 的记忆，无法恢复。仅在用户明确、直接地要求删除某条记忆时使用（如"帮我删掉xxx的记忆"、"忘记xxx"）。绝对不要在用户没有明确要求的情况下自行决定删除记忆。副作用：记忆将被永久删除且无法恢复。',
    input_schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: '要删除的记忆 key',
        },
        scope: {
          type: 'string',
          enum: ['user', 'agent', 'global'],
          description: '记忆的作用域，不填则默认删除 user 作用域',
        },
      },
      required: ['key'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const memory = getMemory();
    const key = String(input.key);
    const scope = input.scope as 'user' | 'agent' | 'global' | undefined;

    const existing = await memory.getFact(key);
    if (existing === null) {
      return `未找到 key 为 "${key}" 的记忆。`;
    }

    await memory.forget(key, scope);
    log.info(`Deleted memory: ${key} (scope: ${scope ?? 'user'})`);
    return `已删除记忆: ${key}${scope ? ` (scope: ${scope})` : ''}`;
  },

  riskLevel: 'high',
  requiresConfirmation: true,
};

export const memorySearchTool: Tool = {
  schema: {
    name: 'memory_search',
    description:
      '语义搜索记忆库。当用户想查找与某个主题相关的记忆时使用此工具。',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询文本',
        },
        topK: {
          type: 'number',
          description: '返回最多几条结果，默认 5',
        },
      },
      required: ['query'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const memory = getMemory();
    const query = String(input.query);
    const topK = Number(input.topK) || 5;

    const results = await memory.searchAdvanced(query, { topK });

    if (results.length === 0) {
      return '没有找到相关记忆。';
    }

    const lines = results.map(
      (r) =>
        `- [${r.key}]: ${r.value} (id: ${r.id}, scope: ${r.scope}, score: ${r.score.toFixed(3)})`,
    );
    return `找到 ${results.length} 条相关记忆：\n${lines.join('\n')}`;
  },
};
