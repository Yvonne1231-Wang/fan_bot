// ─── JSONL Session Store ────────────────────────────────────────────────────

import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
  access,
  stat,
} from 'fs/promises';
import { join, parse } from 'path';
import type { Session, SessionMeta, SessionStore, Message } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Options for creating a JSONL store.
 */
export interface JSONLStoreOptions {
  /** Directory to store session files */
  dir: string;
}

// ─── JSONL Store Implementation ─────────────────────────────────────────────

/**
 * File-based session store using JSONL format.
 *
 * Each session is stored as a separate `.jsonl` file where each line
 * is a JSON-serialized message.
 */
export class JSONLStore implements SessionStore {
  private readonly dir: string;

  constructor(options: JSONLStoreOptions) {
    this.dir = options.dir;
  }

  /**
   * Ensure storage directory exists.
   */
  private async ensureDir(): Promise<void> {
    try {
      await access(this.dir);
    } catch {
      await mkdir(this.dir, { recursive: true });
    }
  }

  /**
   * Get file path for a session.
   */
  private getFilePath(id: string): string {
    // Sanitize ID to prevent directory traversal
    const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dir, `${sanitized}.jsonl`);
  }

  /**
   * Load session from file.
   */
  async load(id: string): Promise<Session | null> {
    const filePath = this.getFilePath(id);

    try {
      const [content, fileStats] = await Promise.all([
        readFile(filePath, 'utf-8'),
        stat(filePath),
      ]);
      const lines = content.trim().split('\n').filter(Boolean);

      const messages: Message[] = [];
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as Message;
          messages.push(message);
        } catch {
          continue;
        }
      }

      return {
        meta: {
          id,
          createdAt: fileStats.birthtimeMs,
          updatedAt: fileStats.mtimeMs,
          messageCount: messages.length,
        },
        messages,
      };
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Save session to file.
   */
  async save(session: Session): Promise<void> {
    await this.ensureDir();

    const filePath = this.getFilePath(session.meta.id);
    const lines = session.messages.map((m) => JSON.stringify(m));
    const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');

    await writeFile(filePath, content, 'utf-8');
  }

  /**
   * Delete session file.
   */
  async delete(id: string): Promise<void> {
    const filePath = this.getFilePath(id);

    try {
      await unlink(filePath);
    } catch (error) {
      const err = error as { code?: string };
      if (err.code !== 'ENOENT') {
        throw error;
      }
      // Ignore if file doesn't exist
    }
  }

  /**
   * List all sessions.
   */
  async list(): Promise<SessionMeta[]> {
    try {
      await this.ensureDir();
      const files = await readdir(this.dir);
      const sessions: SessionMeta[] = [];

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const id = parse(file).name;
        const session = await this.load(id);

        if (session) {
          sessions.push(session.meta);
        }
      }

      // Sort by updated time (newest first)
      return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }
}
