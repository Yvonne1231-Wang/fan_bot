import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool } from './types.js';

const execAsync = promisify(exec);

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
    try {
      const { stdout, stderr } = await execAsync(String(command), {
        timeout: Number(timeout),
        maxBuffer: 1024 * 1024 * 5,
      });
      const output = [stdout, stderr].filter(Boolean).join('\n');
      return output || '(no output)';
    } catch (error: any) {
      return `Exit ${error.code ?? 1}: ${error.stderr || error.message}`;
    }
  },
  riskLevel: 'high',
  requiresConfirmation: true,
};
