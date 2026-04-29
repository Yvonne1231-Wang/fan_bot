// ─── Modification Policy & Code Sanitizer ──────────────────────────────────
// 控制 Agent 自迭代的安全边界：哪些文件能改、代码内容是否安全

import { minimatch } from 'minimatch';
import { createDebug } from '../utils/debug.js';
import type { ModificationPolicy } from './types.js';

const log = createDebug('self-iteration:policy');

// ─── Default Policy ─────────────────────────────────────────────────────────

export const DEFAULT_POLICY: ModificationPolicy = {
  immutablePaths: [
    // 自迭代基础设施自身不可被修改
    'src/self-iteration/**',
    // 认证与密钥
    '.env',
    '.env.*',
    'src/config/secrets.*',
    // 权限系统
    'src/permission/**',
    // 部署配置
    'ecosystem.config.*',
    'Dockerfile',
    'docker-compose.*',
    // Git / CI 配置
    '.gitignore',
    '.github/**',
    // 包管理
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ],
  allowedPaths: [],
  maxFilesPerChange: 5,
  maxLinesPerFile: 200,
  maxTotalDiffLines: 500,
};

// ─── Policy Checker ─────────────────────────────────────────────────────────

/**
 * 检查文件路径是否允许修改
 */
export function isPathAllowed(
  filePath: string,
  policy: ModificationPolicy = DEFAULT_POLICY,
): { allowed: boolean; reason?: string } {
  // 规范化路径：去掉开头的 ./ 或 /
  const normalized = filePath.replace(/^\.\//, '').replace(/^\//, '');

  // 检查不可修改的路径
  for (const pattern of policy.immutablePaths) {
    if (minimatch(normalized, pattern)) {
      return {
        allowed: false,
        reason: `文件 ${normalized} 匹配不可修改规则: ${pattern}`,
      };
    }
  }

  // 如果设置了白名单，检查是否在白名单内
  if (policy.allowedPaths.length > 0) {
    const inAllowList = policy.allowedPaths.some((pattern) =>
      minimatch(normalized, pattern),
    );
    if (!inAllowList) {
      return {
        allowed: false,
        reason: `文件 ${normalized} 不在允许修改的白名单中`,
      };
    }
  }

  return { allowed: true };
}

/**
 * 检查修改范围是否超出限制
 */
export function checkModificationScope(
  files: string[],
  totalDiffLines: number,
  policy: ModificationPolicy = DEFAULT_POLICY,
): { allowed: boolean; reason?: string } {
  if (files.length > policy.maxFilesPerChange) {
    return {
      allowed: false,
      reason: `单次修改文件数 ${files.length} 超过上限 ${policy.maxFilesPerChange}`,
    };
  }

  if (totalDiffLines > policy.maxTotalDiffLines) {
    return {
      allowed: false,
      reason: `总 diff 行数 ${totalDiffLines} 超过上限 ${policy.maxTotalDiffLines}`,
    };
  }

  return { allowed: true };
}

// ─── Code Sanitizer ─────────────────────────────────────────────────────────

interface ScanViolation {
  pattern: string;
  description: string;
  match: string;
}

/** 危险代码模式：LLM 生成的代码不应包含这些 */
const DANGEROUS_PATTERNS: Array<{
  regex: RegExp;
  description: string;
}> = [
  { regex: /eval\s*\(/g, description: '禁止使用 eval()' },
  { regex: /Function\s*\(/g, description: '禁止使用 Function 构造器' },
  {
    regex: /require\s*\(\s*['"`]https?:/g,
    description: '禁止远程 require',
  },
  {
    regex: /import\s+.*from\s+['"`]https?:/g,
    description: '禁止远程 import',
  },
  {
    regex: /fs\.(rm|unlink|rmdir|rmSync|unlinkSync|rmdirSync)\s*\(/g,
    description: '禁止文件删除操作',
  },
  {
    regex: /child_process/g,
    description: '禁止引入 child_process（仅自迭代基础设施可用）',
  },
  {
    // 禁止动态读取环境变量（如 process.env[varName]）
    regex: /process\.env\s*\[/g,
    description: '禁止动态读取环境变量',
  },
];

/**
 * 扫描 LLM 生成的代码，检测危险模式
 */
export function scanCode(
  code: string,
  filePath: string,
): { safe: boolean; violations: ScanViolation[] } {
  const violations: ScanViolation[] = [];

  for (const { regex, description } of DANGEROUS_PATTERNS) {
    // 重置 regex 状态
    regex.lastIndex = 0;
    const match = regex.exec(code);
    if (match) {
      violations.push({
        pattern: regex.source,
        description,
        match: match[0],
      });
      log.warn(`代码安全扫描发现违规: ${description} in ${filePath}`);
    }
  }

  return { safe: violations.length === 0, violations };
}
