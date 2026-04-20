import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool } from './types.js';
import {
  getSandboxService,
  setSandboxSessionContext,
} from '../sandbox/index.js';
import { getToolContext } from './registry.js';
import { createDebug } from '../utils/debug.js';

const execAsync = promisify(exec);
const log = createDebug('tools:shell');

/** child_process.exec rejection shape */
interface ExecError extends Error {
  code?: number;
  stderr?: string;
}

const MAX_SHELL_OUTPUT_CHARS = 20000;

/**
 * 截断过长输出
 */
function truncateOutput(output: string): string {
  if (output.length > MAX_SHELL_OUTPUT_CHARS) {
    log.warn(
      `Shell output truncated: ${output.length} -> ${MAX_SHELL_OUTPUT_CHARS} chars`,
    );
    return (
      output.slice(0, MAX_SHELL_OUTPUT_CHARS) +
      '\n\n[... output truncated due to size limit ...]'
    );
  }
  return output;
}

export const shellTool: Tool = {
  schema: {
    name: 'shell',
    description: 'Run a shell command and return stdout + stderr',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: {
          type: 'number',
          description: 'Timeout in ms (default: 30000)',
        },
      },
      required: ['command'],
    },
  },
  handler: async (input: Record<string, unknown>) => {
    const { command, timeout = 30000 } = input;
    const sandbox = getSandboxService();

    if (sandbox.isEnabled()) {
      const toolCtx = getToolContext();
      setSandboxSessionContext({ sessionId: toolCtx.sessionId });

      log.debug(`Executing in sandbox: ${String(command).slice(0, 80)}`);
      try {
        const result = await sandbox.execute(String(command), Number(timeout));
        if (result.timedOut) {
          return `Command timed out after ${timeout}ms`;
        }
        const output = [result.stdout, result.stderr]
          .filter(Boolean)
          .join('\n');
        return output || '(no output)';
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return `Sandbox error: ${message}`;
      }
    }

    try {
      const { stdout, stderr } = await execAsync(String(command), {
        timeout: Number(timeout),
        maxBuffer: 1024 * 1024,
      });
      let output = [stdout, stderr].filter(Boolean).join('\n');
      output = truncateOutput(output);
      return output || '(no output)';
    } catch (error: unknown) {
      const e = error as ExecError;
      return `Exit ${e.code ?? 1}: ${e.stderr || e.message}`;
    }
  },
  riskLevel: 'high',
  requiresConfirmation: true,
};
