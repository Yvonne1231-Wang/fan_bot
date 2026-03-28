/**
 * Cron Security Module - 安全加固措施
 *
 * 提供：
 * 1. Shell 命令白名单
 * 2. 文件路径限制
 * 3. 任务签名验证
 */

import { createHash, createHmac } from 'crypto';
import { resolve, isAbsolute, relative } from 'path';

const ALLOWED_SHELL_COMMANDS = new Set([
  '/usr/bin/backup.sh',
  '/usr/local/bin/cleanup.sh',
  '/usr/bin/notify.sh',
]);

const DEFAULT_ALLOWED_DIRS = [
  process.cwd(),
  `${process.cwd()}/sessions`,
  `${process.cwd()}/data`,
];

const HMAC_SECRET = process.env.CRON_HMAC_SECRET || '';

export interface SecurityConfig {
  shellWhitelist?: string[];
  allowedDirs?: string[];
  hmacSecret?: string;
  enforceShellWhitelist?: boolean;
  enforcePathRestriction?: boolean;
}

const securityConfig: SecurityConfig = {
  shellWhitelist: [],
  allowedDirs: [...DEFAULT_ALLOWED_DIRS],
  hmacSecret: HMAC_SECRET,
  enforceShellWhitelist: Boolean(HMAC_SECRET),
  enforcePathRestriction: true,
};

export function configureSecurity(config: SecurityConfig): void {
  if (config.shellWhitelist) {
    securityConfig.shellWhitelist = config.shellWhitelist;
  }
  if (config.allowedDirs) {
    securityConfig.allowedDirs = config.allowedDirs;
  }
  if (config.hmacSecret !== undefined) {
    securityConfig.hmacSecret = config.hmacSecret;
  }
  if (config.enforceShellWhitelist !== undefined) {
    securityConfig.enforceShellWhitelist = config.enforceShellWhitelist;
  }
  if (config.enforcePathRestriction !== undefined) {
    securityConfig.enforcePathRestriction = config.enforcePathRestriction;
  }
}

export function getSecurityConfig(): SecurityConfig {
  return { ...securityConfig };
}

/**
 * 验证 shell 命令是否在白名单中
 */
export function isShellCommandAllowed(command: string): boolean {
  if (!securityConfig.enforceShellWhitelist) {
    return true;
  }

  const allowed = securityConfig.shellWhitelist || ALLOWED_SHELL_COMMANDS;
  const allowedArray = allowed instanceof Set ? Array.from(allowed) : allowed;

  if (allowedArray.length === 0) {
    return true;
  }

  for (const allowedCmd of allowedArray) {
    if (command.includes(allowedCmd)) {
      return true;
    }
  }

  return false;
}

/**
 * 验证文件路径是否在允许范围内
 */
export function isPathAllowed(filePath: string): boolean {
  if (!securityConfig.enforcePathRestriction) {
    return true;
  }

  const allowedDirs = securityConfig.allowedDirs || DEFAULT_ALLOWED_DIRS;

  const resolvedPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(process.cwd(), filePath);

  for (const allowedDir of allowedDirs) {
    const resolvedAllowed = resolve(allowedDir);
    const rel = relative(resolvedAllowed, resolvedPath);

    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      return true;
    }
  }

  return false;
}

/**
 * 验证文件路径并返回安全版本
 */
export function validatePath(filePath: string): string {
  if (!isPathAllowed(filePath)) {
    throw new SecurityError(
      `Path not allowed: ${filePath}. Allowed dirs: ${securityConfig.allowedDirs?.join(', ')}`,
    );
  }

  return isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(process.cwd(), filePath);
}

/**
 * 计算数据签名
 */
export function computeSignature(data: string): string {
  if (!securityConfig.hmacSecret) {
    return '';
  }

  const hmac = createHmac('sha256', securityConfig.hmacSecret);
  hmac.update(data);
  return hmac.digest('hex');
}

/**
 * 验证数据签名
 */
export function verifySignature(data: string, signature: string): boolean {
  if (!securityConfig.hmacSecret) {
    return true;
  }

  if (!signature) {
    return false;
  }

  const expected = computeSignature(data);
  return timingSafeEqual(expected, signature);
}

/**
 * 时序安全的字符串比较
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * 计算内容的哈希值
 */
export function computeHash(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

export function validateShellCommand(command: string): void {
  if (!isShellCommandAllowed(command)) {
    throw new SecurityError(
      `Shell command not in whitelist. Command: ${command.slice(0, 50)}...`,
    );
  }
}

export function sanitizeShellArgument(arg: string): string {
  return arg.replace(/[`$\\;*?<>|&`]/g, '').slice(0, 1000);
}
