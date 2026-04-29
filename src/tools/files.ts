import { readFile, writeFile, readdir, stat, realpath } from 'fs/promises';
import { join, resolve, relative, basename } from 'path';
import { existsSync } from 'fs';
import type { Tool } from './types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('tools:files');

const MAX_FILE_SIZE = 20000;

// ============================================================
// 路径安全检查
// ============================================================

/**
 * 项目根目录白名单
 * 默认为当前工作目录，可通过 FILE_ACCESS_ROOT 环境变量覆盖
 */
const PROJECT_ROOT = resolve(process.env.FILE_ACCESS_ROOT || process.cwd());

/**
 * 敏感文件模式（禁止访问）
 * 包括：环境变量文件、凭证文件、私钥文件等
 */
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,           // .env, .env.local, .env.production 等
  /\.env$/i,                    // 以 .env 结尾
  /credentials/i,               // 包含 credentials
  /\.pem$/i,                    // PEM 证书
  /\.key$/i,                    // 密钥文件
  /id_rsa/i,                    // SSH 私钥
  /id_ed25519/i,                // ED25519 私钥
  /\.p12$/i,                    // PKCS12 证书
  /\.pfx$/i,                    // PFX 证书
  /\.git[\\/]/,                 // .git 目录内容
];

/**
 * 允许访问的敏感文件例外（在项目目录内但需要允许访问）
 */
const ALLOWED_SENSITIVE_EXCEPTIONS = [
  /\.env\.example$/i,           // .env.example 可以访问
];

/**
 * 检查路径是否安全（在项目目录内且非敏感文件）
 * @param inputPath 用户提供的路径
 * @param operation 操作类型，用于错误信息
 * @returns 解析后的绝对路径
 * @throws Error 如果路径不安全
 */
async function assertSafePath(inputPath: string, operation: string): Promise<string> {
  // 1. 解析为绝对路径
  const absolutePath = resolve(inputPath);

  // 2. 检查是否在项目目录内
  const relativePath = relative(PROJECT_ROOT, absolutePath);

  // 如果相对路径以 .. 开头，说明在项目目录外
  if (relativePath.startsWith('..') || relativePath.startsWith('/')) {
    throw new Error(
      `Path access denied: "${inputPath}" is outside project directory.\n` +
      `Allowed directory: ${PROJECT_ROOT}\n` +
      `To allow access to other directories, set FILE_ACCESS_ROOT environment variable.`
    );
  }

  // 3. 检查符号链接是否指向项目外（如果文件存在）
  if (existsSync(absolutePath)) {
    try {
      const realPath = await realpath(absolutePath);
      const realRelative = relative(PROJECT_ROOT, realPath);
      if (realRelative.startsWith('..') || realRelative.startsWith('/')) {
        throw new Error(
          `Path access denied: "${inputPath}" is a symlink pointing outside project directory.`
        );
      }
    } catch {
      // 文件不存在或其他错误，继续其他检查
    }
  }

  // 4. 检查是否为敏感文件
  const fileName = basename(absolutePath);

  // 先检查例外
  const isException = ALLOWED_SENSITIVE_EXCEPTIONS.some(pattern => pattern.test(fileName));

  if (!isException) {
    const isSensitive = SENSITIVE_FILE_PATTERNS.some(pattern => pattern.test(absolutePath));
    if (isSensitive) {
      throw new Error(
        `Access to sensitive file denied: "${inputPath}"\n` +
        `This file may contain secrets or credentials.`
      );
    }
  }

  log.debug(`Path validated for ${operation}: ${absolutePath}`);
  return absolutePath;
}

export const readFileTool: Tool = {
  schema: {
    name: 'read_file',
    description: 'Read the contents of a file. Only files within the project directory can be accessed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read (must be within project directory)' },
      },
      required: ['path'],
    },
  },
  handler: async ({ path }) => {
    const filePath = await assertSafePath(String(path), 'read');
    const content = await readFile(filePath, 'utf-8');
    if (content.length > MAX_FILE_SIZE) {
      return (
        content.slice(0, MAX_FILE_SIZE) +
        '\n\n[... truncated, file too large ...]'
      );
    }
    return content;
  },
};

export const writeFileTool: Tool = {
  schema: {
    name: 'write_file',
    description: 'Write content to a file. Only files within the project directory can be written.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write (must be within project directory)' },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  handler: async ({ path, content }) => {
    const filePath = await assertSafePath(String(path), 'write');
    const fileContent = String(content);
    await writeFile(filePath, fileContent, 'utf-8');
    return `Written ${fileContent.length} characters to ${filePath}`;
  },
  riskLevel: 'medium',
};

export const listDirTool: Tool = {
  schema: {
    name: 'list_dir',
    description: 'List directory contents. Only directories within the project directory can be accessed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list (must be within project directory)' },
      },
      required: ['path'],
    },
  },
  handler: async ({ path }) => {
    const dirPath = await assertSafePath(String(path), 'list_dir');
    log.debug(`list_dir handler called with path: ${dirPath}`);
    const entries = await readdir(dirPath);
    const items: string[] = [];

    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      try {
        const stats = await stat(fullPath);
        if (stats.isDirectory()) {
          items.push(`${entry}/`);
        } else {
          items.push(entry);
        }
      } catch {
        items.push(entry);
      }
    }

    return items.join('\n');
  },
};
