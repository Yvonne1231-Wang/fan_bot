import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { Tool } from './types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('tools:files');

const MAX_FILE_SIZE = 20000;

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
