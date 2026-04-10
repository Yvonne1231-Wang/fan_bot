// ─── Debug Logging Utility ──────────────────────────────────────────────────

/**
 * Debug logging system with namespace filtering.
 *
 * Usage:
 *   import { createDebug } from './utils/debug.js';
 *   const log = createDebug('agent:loop');
 *
 *   log('Starting agent loop');           // Always logged
 *   log.verbose('Token count: %d', 100);  // Only if DEBUG=agent:* or DEBUG=*
 *
 * Enable via environment variable:
 *   DEBUG=*                     // Enable all debug output
 *   DEBUG=agent:*              // Enable all agent module debug
 *   DEBUG=agent:loop,llm:*     // Enable specific namespaces
 *   DEBUG=                      // Disable all debug output (default)
 *
 * File logging (optional):
 *   LOG_FILE=./logs/bot.log    // Also write logs to file
 *   LOG_MAX_SIZE_MB=10         // Max log file size before rotation (default: 10MB)
 *   LOG_MAX_AGE_DAYS=7         // Days to keep old logs (default: 7)
 *   LOG_ROTATE_BY_DATE=true    // Rotate log file daily (default: true)
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { dirname, basename, extname } from 'path';
import { join } from 'path';

export enum LogLevel {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  DEBUG = 'debug',
  VERBOSE = 'verbose',
}

let logFileBasePath: string | null = null;
let currentLogFile: string | null = null;
let currentLogDate: string | null = null;

/**
 * 获取日志文件基础路径
 */
function getLogFileBase(): string | null {
  const logFile = process.env.LOG_FILE || './logs/bot.log';
  if (!logFile) return null;

  if (!logFileBasePath) {
    const dir = dirname(logFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    logFileBasePath = logFile;
  }
  return logFileBasePath;
}

/**
 * 获取当前日期字符串 (YYYY-MM-DD)
 */
function getCurrentDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 获取带时间戳的轮转文件名
 */
function getRotatedFileName(basePath: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = dirname(basePath);
  const base = basename(basePath, extname(basePath));
  const ext = extname(basePath) || '.log';
  return join(dir, `${base}.${timestamp}${ext}`);
}

/**
 * 获取按日期分割的日志文件名
 */
function getDatedLogFileName(basePath: string, date: string): string {
  const dir = dirname(basePath);
  const base = basename(basePath, extname(basePath));
  const ext = extname(basePath) || '.log';
  return join(dir, `${base}.${date}${ext}`);
}

/**
 * 检查是否启用按日期分割日志
 */
function shouldRotateByDate(): boolean {
  return process.env.LOG_ROTATE_BY_DATE !== 'false';
}

/**
 * 获取当前应该使用的日志文件路径
 * 如果启用了按日期分割，会根据日期自动切换文件
 */
function getCurrentLogFile(): string | null {
  const basePath = getLogFileBase();
  if (!basePath) return null;

  if (!shouldRotateByDate()) {
    return basePath;
  }

  const today = getCurrentDateString();

  if (currentLogDate !== today || !currentLogFile) {
    currentLogDate = today;
    currentLogFile = getDatedLogFileName(basePath, today);
  }

  return currentLogFile;
}

/**
 * 写入日志到文件
 */
function writeToFile(output: string): void {
  const logFile = getCurrentLogFile();
  if (!logFile) return;

  try {
    appendFileSync(logFile, output + '\n');
    maybeRotateLog();
  } catch (err) {
    console.error('[DEBUG] Failed to write to log file:', err);
  }
}

let lastRotationCheck = 0;
let lastCleanupCheck = 0;
const ROTATION_CHECK_INTERVAL = 60 * 1000;
const CLEANUP_CHECK_INTERVAL = 60 * 60 * 1000;
const DEFAULT_MAX_SIZE_MB = 10;
const DEFAULT_MAX_AGE_DAYS = 7;

function getMaxSizeBytes(): number {
  const env = process.env.LOG_MAX_SIZE_MB;
  return env
    ? parseInt(env, 10) * 1024 * 1024
    : DEFAULT_MAX_SIZE_MB * 1024 * 1024;
}

function getMaxAgeMs(): number {
  const env = process.env.LOG_MAX_AGE_DAYS;
  return env
    ? parseInt(env, 10) * 24 * 60 * 60 * 1000
    : DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * 轮转日志文件（按大小）
 * 当日志文件超过最大大小时，重命名为带时间戳的文件
 */
function rotateLog(logFile: string): void {
  try {
    const rotatedFile = getRotatedFileName(logFile);
    renameSync(logFile, rotatedFile);
    console.log(`[DEBUG] Log rotated to ${rotatedFile}`);
  } catch (err) {
    console.error('[DEBUG] Failed to rotate log:', err);
  }
}

/**
 * 清理过期的日志文件
 */
function cleanupOldLogs(): void {
  const basePath = getLogFileBase();
  if (!basePath) return;

  const logDir = dirname(basePath);
  const base = basename(basePath, extname(basePath));
  const maxAge = getMaxAgeMs();
  const now = Date.now();

  try {
    const files = readdirSync(logDir);
    const logFiles = files.filter((f) => {
      return f.startsWith(base) && f !== basename(basePath);
    });

    for (const file of logFiles) {
      const filePath = join(logDir, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          unlinkSync(filePath);
          console.log(`[DEBUG] Deleted old log: ${file}`);
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // skip if directory doesn't exist
  }
}

/**
 * 检查是否需要轮转或清理日志
 */
function maybeRotateLog(): void {
  const now = Date.now();
  const basePath = getLogFileBase();
  if (!basePath) return;

  if (shouldRotateByDate()) {
    if (now - lastCleanupCheck >= CLEANUP_CHECK_INTERVAL) {
      lastCleanupCheck = now;
      cleanupOldLogs();
    }
    return;
  }

  if (now - lastRotationCheck < ROTATION_CHECK_INTERVAL) return;
  lastRotationCheck = now;

  try {
    const stat = statSync(basePath);
    const maxSize = getMaxSizeBytes();
    if (stat.size > maxSize) {
      rotateLog(basePath);
    }
    if (now - lastCleanupCheck >= CLEANUP_CHECK_INTERVAL) {
      lastCleanupCheck = now;
      cleanupOldLogs();
    }
  } catch {
    // file might not exist yet
  }
}

function matchesPattern(pattern: string, namespace: string): boolean {
  if (pattern === '*') return true;

  const patternParts = pattern.split(':');
  const namespaceParts = namespace.split(':');

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    const n = namespaceParts[i];

    if (p === '*') return true;
    if (p !== n) return false;
  }

  return patternParts.length === namespaceParts.length;
}

function isEnabledNow(namespace: string): boolean {
  const debugEnv = process.env.DEBUG || '';
  if (!debugEnv) return false;

  const patterns = debugEnv
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  for (const pattern of patterns) {
    if (matchesPattern(pattern, namespace)) return true;
  }

  return false;
}

/**
 * Format timestamp for log prefix.
 */
function timestamp(): string {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

/**
 * Create a debug logger for a specific namespace.
 *
 * @param namespace - Dot-separated namespace (e.g., 'agent:loop')
 * @returns Logger object with info, warn, error, debug, verbose methods
 */
export function createDebug(namespace: string): DebugLogger {
  const prefix = `[${timestamp()}] [${namespace}]`;

  function formatMessage(
    level: LogLevel,
    message: string,
    ...args: unknown[]
  ): string {
    const levelStr = level.toUpperCase().padEnd(7);
    let formatted = `${prefix} [${levelStr}] ${message}`;

    if (args.length > 0) {
      formatted +=
        ' ' +
        args
          .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
          .join(' ');
    }

    return formatted;
  }

  function log(level: LogLevel, message: string, ...args: unknown[]): void {
    const enabled = isEnabledNow(namespace);
    if (!enabled) return;

    const output = formatMessage(level, message, ...args);

    switch (level) {
      case LogLevel.ERROR:
        console.error(output);
        break;
      case LogLevel.WARN:
        console.warn(output);
        break;
      case LogLevel.VERBOSE:
        console.log(output);
        break;
      default:
        console.log(output);
    }

    writeToFile(output);
  }

  return {
    enabled: isEnabledNow(namespace),
    namespace,

    info(message: string, ...args: unknown[]): void {
      log(LogLevel.INFO, message, ...args);
    },

    warn(message: string, ...args: unknown[]): void {
      log(LogLevel.WARN, message, ...args);
    },

    error(message: string, ...args: unknown[]): void {
      log(LogLevel.ERROR, message, ...args);
    },

    debug(message: string, ...args: unknown[]): void {
      log(LogLevel.DEBUG, message, ...args);
    },

    verbose(message: string, ...args: unknown[]): void {
      log(LogLevel.VERBOSE, message, ...args);
    },

    timing(label: string, startMs: number, endMs?: number): void {
      if (!isEnabledNow(namespace)) return;
      const duration = endMs ? endMs - startMs : Date.now() - startMs;
      console.log(`${prefix} [TIMING] ${label}: ${duration}ms`);
    },

    obj(label: string, obj: unknown): void {
      if (!isEnabledNow(namespace)) return;
      console.log(`${prefix} [${label}]`);
      console.dir(obj, { depth: 5, colors: true });
    },
  };
}

/**
 * Debug logger interface.
 */
export interface DebugLogger {
  enabled: boolean;
  namespace: string;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  verbose(message: string, ...args: unknown[]): void;
  timing(label: string, startMs: number, endMs?: number): void;
  obj(label: string, obj: unknown): void;
}

/**
 * Shorthand export for convenience.
 */
export const debug = createDebug;

/**
 * Pre-defined debug loggers for common modules.
 * Usage: import { log } from './utils/debug.js';
 */
export const log = {
  agent: {
    loop: createDebug('agent:loop'),
    index: createDebug('agent:index'),
  },
  llm: {
    index: createDebug('llm:index'),
    anthropic: createDebug('llm:anthropic'),
    openai: createDebug('llm:openai'),
  },
  session: {
    manager: createDebug('session:manager'),
    store: createDebug('session:store'),
  },
  tools: {
    registry: createDebug('tools:registry'),
    calculator: createDebug('tools:calculator'),
  },
  transport: {
    cli: createDebug('transport:cli'),
    http: createDebug('transport:http'),
  },
};
