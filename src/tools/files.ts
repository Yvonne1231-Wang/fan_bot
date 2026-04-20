import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { Tool } from './types.js';
import { getSandboxService, setSandboxSessionContext } from '../sandbox/index.js';
import { getToolContext } from './registry.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('tools:files');

const MAX_FILE_SIZE = 20000;

/**
 * 在沙箱模式下注入当前会话上下文
 */
function injectSessionContext(): void {
  const sandbox = getSandboxService();
  if (sandbox.isEnabled()) {
    const toolCtx = getToolContext();
    setSandboxSessionContext({ sessionId: toolCtx.sessionId });
  }
}

export const readFileTool: Tool = {
  schema: {
    name: 'read_file',
    description: 'Read the contents of a file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
    },
  },
  handler: async ({ path }) => {
    const filePath = String(path);
    const sandbox = getSandboxService();

    if (sandbox.isEnabled()) {
      injectSessionContext();
      log.debug(`Reading file in sandbox: ${filePath}`);
      try {
        return await sandbox.readFile(filePath);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return `Sandbox error: ${message}`;
      }
    }

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
    description: 'Write content to a file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  handler: async ({ path, content }) => {
    const filePath = String(path);
    const fileContent = String(content);
    const sandbox = getSandboxService();

    if (sandbox.isEnabled()) {
      injectSessionContext();
      log.debug(`Writing file in sandbox: ${filePath}`);
      try {
        await sandbox.writeFile(filePath, fileContent);
        return `Written ${fileContent.length} characters to ${filePath}`;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return `Sandbox error: ${message}`;
      }
    }

    await writeFile(filePath, fileContent, 'utf-8');
    return `Written ${fileContent.length} characters to ${filePath}`;
  },
  riskLevel: 'medium',
};

export const listDirTool: Tool = {
  schema: {
    name: 'list_dir',
    description: 'List directory contents',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
      },
      required: ['path'],
    },
  },
  handler: async ({ path }) => {
    const dirPath = String(path);
    const sandbox = getSandboxService();

    if (sandbox.isEnabled()) {
      injectSessionContext();
      log.debug(`Listing directory in sandbox: ${dirPath}`);
      try {
        const entries = await sandbox.listDir(dirPath);
        return entries.join('\n');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return `Sandbox error: ${message}`;
      }
    }

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
