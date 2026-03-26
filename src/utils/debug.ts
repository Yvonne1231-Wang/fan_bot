// ─── Debug Logging Utility ──────────────────────────────────────────────────

/**
 * Debug logging system with namespace filtering.
 *
 * Usage:
 *   import { debug } from './utils/debug.js';
 *   const log = debug('agent:loop');
 *
 *   log('Starting agent loop');           // Always logged
 *   log.verbose('Token count: %d', 100);  // Only if DEBUG=agent:* or DEBUG=*
 *
 * Enable via environment variable:
 *   DEBUG=*                     // Enable all debug output
 *   DEBUG=agent:*              // Enable all agent module debug
 *   DEBUG=agent:loop,llm:*     // Enable specific namespaces
 *   DEBUG=                      // Disable all debug output (default)
 */

const DEBUG_ENV = process.env.DEBUG || '';

/**
 * Log levels for more granular control.
 */
export enum LogLevel {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  DEBUG = 'debug',
  VERBOSE = 'verbose',
}

/**
 * Check if a namespace pattern matches an actual namespace.
 * Supports wildcards:
 *   - '*' matches everything in that segment
 *   - 'foo:*' matches 'foo:bar', 'foo:baz', etc.
 *   - 'foo' matches only 'foo' (not 'foo:bar')
 */
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

/**
 * Check if a namespace is enabled based on DEBUG env var.
 */
function isEnabled(namespace: string): boolean {
  if (!DEBUG_ENV) return false;

  const patterns = DEBUG_ENV.split(',').map((p) => p.trim()).filter(Boolean);

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
  const enabled = isEnabled(namespace);
  const prefix = `[${timestamp()}] [${namespace}]`;

  function formatMessage(
    level: LogLevel,
    message: string,
    ...args: unknown[]
  ): string {
    const levelStr = level.toUpperCase().padEnd(7);
    let formatted = `${prefix} [${levelStr}] ${message}`;

    if (args.length > 0) {
      formatted += ' ' + args
        .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ');
    }

    return formatted;
  }

  function log(level: LogLevel, message: string, ...args: unknown[]): void {
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
  }

  return {
    enabled,
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

    /**
     * Log timing information in a consistent format.
     */
    timing(label: string, startMs: number, endMs?: number): void {
      if (!enabled) return;
      const duration = endMs ? endMs - startMs : Date.now() - startMs;
      console.log(`${prefix} [TIMING] ${label}: ${duration}ms`);
    },

    /**
     * Log an object with syntax highlighting.
     */
    obj(label: string, obj: unknown): void {
      if (!enabled) return;
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