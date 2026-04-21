// ─── Self-Iteration Tools ───────────────────────────────────────────────────
// 将自迭代能力注册为 Agent 可调用工具

import type { Tool } from './types.js';
import {
  createSelfIteration,
  type SelfIteration,
  type CodeChangeRequest,
  type OperatorInfo,
} from '../self-iteration/index.js';
import { createDebug } from '../utils/debug.js';
import { getToolContext } from './registry.js';

const log = createDebug('tools:self-iteration');

// ─── Singleton ──────────────────────────────────────────────────────────────

let instance: SelfIteration | null = null;

function getSelfIteration(): SelfIteration {
  if (!instance) {
    instance = createSelfIteration({
      workDir: process.cwd(),
      mainBranch: 'main',
      skipSandbox: process.env.NODE_ENV === 'development',
    });
  }
  return instance;
}

let initialized = false;

async function ensureInitialized(): Promise<SelfIteration> {
  const si = getSelfIteration();
  if (!initialized) {
    await si.initialize();
    initialized = true;
  }
  return si;
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function extractOperator(): OperatorInfo {
  const ctx = getToolContext();
  return {
    type: 'user',
    userId: ctx.userId ?? 'unknown',
    userName: ctx.userId ?? 'agent',
  };
}

// ─── Tool 1: self_modify ────────────────────────────────────────────────────

export const selfModifyTool: Tool = {
  schema: {
    name: 'self_modify',
    description: [
      '修改 Agent 自身代码。在隔离 Git 分支上执行修改，经过安全扫描和验证（tsc + test + sandbox）后合并到主分支，',
      '自动 build 并重启服务。',
      '',
      '使用场景：',
      '- 用户要求修改/新增/删除 Agent 的某个功能',
      '- 需要修复 Agent 代码中的 bug',
      '- 用户提供了具体的代码改动',
      '',
      '安全限制：',
      '- 不能修改 .env / credentials / 安全策略等敏感文件',
      '- 单次最多修改 5 个文件、每个文件最多 500 行',
      '- 代码会经过危险模式扫描（eval / exec / 网络请求等）',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: '本次修改的描述，将作为 commit message',
        },
        changes: {
          type: 'array',
          description: '文件变更列表',
          items: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: '相对项目根的文件路径，如 src/tools/calculator.ts',
              },
              content: {
                type: 'string',
                description: '文件的完整新内容',
              },
            },
            required: ['filePath', 'content'],
          },
        },
        intent: {
          type: 'string',
          enum: ['modify', 'add', 'delete'],
          description: '修改意图：modify=修改现有文件, add=新增文件, delete=删除文件',
        },
      },
      required: ['description', 'changes'],
    },
  },

  handler: async (input: Record<string, unknown>) => {
    const si = await ensureInitialized();
    const operator = extractOperator();

    const description = String(input.description ?? '');
    const intent = (String(input.intent ?? 'modify')) as CodeChangeRequest['intent'];
    const changes = input.changes as Array<{ filePath: string; content: string }>;

    if (!changes || changes.length === 0) {
      return '❌ 未提供任何文件变更';
    }

    const request: CodeChangeRequest = {
      intent,
      targetFile: changes.map((c) => c.filePath).join(', '),
      description,
      operator,
      rawMessage: description,
    };

    log.info(`self_modify: ${description} (${changes.length} files)`);

    const result = await si.modify(request, changes);

    if (result.success) {
      return [
        `✅ 代码修改成功`,
        `- 分支: ${result.branch}`,
        `- Commit: ${result.commitHash.slice(0, 8)}`,
        `- Tag: ${result.tag}`,
        `- 耗时: ${result.duration}ms`,
        '',
        '已自动 build 并重启服务，变更即刻生效。',
      ].join('\n');
    } else {
      return [
        `❌ 代码修改失败`,
        `- 原因: ${result.error}`,
        result.validationResults
          ? `- 验证详情: tsc=${result.validationResults.tscPass ? '✓' : '✗'} test=${result.validationResults.testPass ? '✓' : '✗'} sandbox=${result.validationResults.sandboxPass ? '✓' : '✗'}`
          : '',
        `- 耗时: ${result.duration}ms`,
        '',
        '所有修改已自动回滚，代码库保持原状。',
      ]
        .filter(Boolean)
        .join('\n');
    }
  },

  riskLevel: 'high',
  requiresConfirmation: true,
  parallelSafe: false,
};

// ─── Tool 2: self_rollback ──────────────────────────────────────────────────

export const selfRollbackTool: Tool = {
  schema: {
    name: 'self_rollback',
    description: [
      '回退 Agent 代码到指定版本。',
      '',
      '支持的目标格式：',
      '- "last"：回退到上一个自动版本',
      '- tag 名称：如 "v-auto-1234567890"',
      '- commit hash：如 "abc1234"',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '回退目标："last"、tag 名称、或 commit hash',
        },
        reason: {
          type: 'string',
          description: '回退原因',
        },
      },
      required: ['target'],
    },
  },

  handler: async (input: Record<string, unknown>) => {
    const si = await ensureInitialized();
    const operator = extractOperator();

    const target = String(input.target);
    const reason = String(input.reason ?? '用户请求回退');

    log.info(`self_rollback: target=${target}, reason=${reason}`);

    const result = await si.rollback(target, operator, reason);

    if (result.success) {
      return [
        `✅ 回退成功`,
        `- 当前版本: ${result.commitHash.slice(0, 8)}`,
        `- 回退标记: ${result.tag}`,
        `- 耗时: ${result.duration}ms`,
        '',
        '需要手动执行 build 和 restart 以生效。',
      ].join('\n');
    } else {
      return `❌ 回退失败: ${result.error}`;
    }
  },

  riskLevel: 'high',
  requiresConfirmation: true,
  parallelSafe: false,
};

// ─── Tool 3: self_versions ──────────────────────────────────────────────────

export const selfVersionsTool: Tool = {
  schema: {
    name: 'self_versions',
    description: [
      '查询 Agent 的自动修改版本历史和审计日志。',
      '',
      '用于查看最近有哪些自动修改、谁触发的、是否成功等信息。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['versions', 'audit'],
          description: '"versions" 查看版本列表，"audit" 查看审计日志',
        },
        limit: {
          type: 'number',
          description: '返回条数，默认 10',
        },
      },
      required: ['action'],
    },
  },

  handler: async (input: Record<string, unknown>) => {
    const si = await ensureInitialized();

    const action = String(input.action);
    const limit = Number(input.limit ?? 10);

    if (action === 'versions') {
      const versions = si.listVersions(limit);
      if (versions.length === 0) return '暂无自动修改版本记录';
      return `📋 自动修改版本历史（最近 ${versions.length} 条）:\n\n${si.formatVersionList(versions)}`;
    }

    if (action === 'audit') {
      const formatted = si.formatAuditLogs(limit);
      return `📋 审计日志（最近 ${limit} 条）:\n\n${formatted}`;
    }

    return '❌ 无效的 action，请使用 "versions" 或 "audit"';
  },

  riskLevel: 'low',
  parallelSafe: true,
};
