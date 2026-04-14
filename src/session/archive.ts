// ─── Session Archive (FTS5) ─────────────────────────────────────────────────
//
// 将完整会话归档到 SQLite + FTS5 索引。
// 压缩后原始上下文不再丢失——可通过关键词精确检索。
// 支持 "上次那个方案"、"之前讨论的 X" 类查询。

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Message, TextBlock, ToolUseBlock } from '../llm/types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('session:archive');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ArchiveSearchOptions {
  userId?: string;
  /** 只搜最近 N 天 */
  maxAgeDays?: number;
  /** 返回条数上限 */
  limit?: number;
}

export interface ArchiveResult {
  sessionId: string;
  messageIndex: number;
  role: string;
  content: string;
  timestamp: number;
  /** FTS5 BM25 score（越小越相关） */
  score: number;
}

export interface ArchiveStats {
  totalSessions: number;
  totalMessages: number;
}

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS archived_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  message_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_names TEXT DEFAULT '',
  timestamp INTEGER NOT NULL,
  UNIQUE(session_id, message_index)
);

CREATE INDEX IF NOT EXISTS idx_archived_session ON archived_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_archived_user ON archived_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_archived_ts ON archived_messages(timestamp);
`;

const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS archived_messages_fts USING fts5(
  content,
  tool_names,
  content='archived_messages',
  content_rowid='id',
  tokenize='porter unicode61'
);
`;

const FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS archived_messages_ai AFTER INSERT ON archived_messages BEGIN
  INSERT INTO archived_messages_fts(rowid, content, tool_names)
    VALUES (new.id, new.content, new.tool_names);
END;

CREATE TRIGGER IF NOT EXISTS archived_messages_ad AFTER DELETE ON archived_messages BEGIN
  INSERT INTO archived_messages_fts(archived_messages_fts, rowid, content, tool_names)
    VALUES ('delete', old.id, old.content, old.tool_names);
END;
`;

// ─── Implementation ─────────────────────────────────────────────────────────

export class SessionArchive {
  private db: DatabaseType;

  constructor(dbPath: string = '.fan_bot/archive.db') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // WAL 模式提升并发性能
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(SCHEMA_SQL);
    this.db.exec(FTS_SCHEMA_SQL);
    this.db.exec(FTS_TRIGGERS_SQL);

    log.debug(`Session archive initialized at ${dbPath}`);
  }

  /**
   * 归档一次完整会话的消息。
   * 使用 INSERT OR IGNORE 避免重复归档。
   */
  archive(
    sessionId: string,
    messages: Message[],
    userId: string = '',
  ): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO archived_messages
        (session_id, user_id, message_index, role, content, tool_names, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    let archived = 0;

    const runInserts = this.db.transaction(() => {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const content = this.extractText(msg);
        if (!content.trim()) continue;

        const toolNames = this.extractToolNames(msg);

        insert.run(
          sessionId,
          userId,
          i,
          msg.role,
          content,
          toolNames.join(','),
          now,
        );
        archived++;
      }
    });

    runInserts();
    log.debug(`Archived ${archived} messages for session ${sessionId}`);
  }

  /**
   * FTS5 全文检索归档消息。
   */
  search(
    query: string,
    options: ArchiveSearchOptions = {},
  ): ArchiveResult[] {
    const { userId, maxAgeDays, limit = 20 } = options;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // FTS5 MATCH 条件
    conditions.push('f.archived_messages_fts MATCH ?');
    params.push(query);

    if (userId) {
      conditions.push('m.user_id = ?');
      params.push(userId);
    }

    if (maxAgeDays) {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      conditions.push('m.timestamp > ?');
      params.push(cutoff);
    }

    params.push(limit);

    const sql = `
      SELECT
        m.session_id AS sessionId,
        m.message_index AS messageIndex,
        m.role,
        m.content,
        m.timestamp,
        rank AS score
      FROM archived_messages_fts f
      JOIN archived_messages m ON m.id = f.rowid
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `;

    try {
      const rows = this.db.prepare(sql).all(...params) as ArchiveResult[];
      log.debug(`Archive search "${query}": ${rows.length} results`);
      return rows;
    } catch (error) {
      // FTS5 query syntax error（比如特殊字符）
      log.warn(`Archive search failed for "${query}": ${error}`);
      return [];
    }
  }

  /**
   * 按会话 ID 检索所有消息。
   */
  getSession(sessionId: string): ArchiveResult[] {
    const sql = `
      SELECT session_id AS sessionId, message_index AS messageIndex, role, content, timestamp, 0 as score
      FROM archived_messages
      WHERE session_id = ?
      ORDER BY message_index
    `;
    return this.db.prepare(sql).all(sessionId) as ArchiveResult[];
  }

  /**
   * 统计信息。
   */
  stats(): ArchiveStats {
    const sessionCount = this.db
      .prepare('SELECT COUNT(DISTINCT session_id) as cnt FROM archived_messages')
      .get() as { cnt: number };
    const msgCount = this.db
      .prepare('SELECT COUNT(*) as cnt FROM archived_messages')
      .get() as { cnt: number };

    return {
      totalSessions: sessionCount.cnt,
      totalMessages: msgCount.cnt,
    };
  }

  /**
   * 清理超过指定天数的归档。
   */
  cleanup(maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const result = this.db
      .prepare('DELETE FROM archived_messages WHERE timestamp < ?')
      .run(cutoff);
    const deleted = result.changes;
    if (deleted > 0) {
      log.info(`Cleaned up ${deleted} archived messages older than ${maxAgeDays} days`);
    }
    return deleted;
  }

  /**
   * 关闭数据库连接。
   */
  close(): void {
    this.db.close();
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private extractText(msg: Message): string {
    return msg.content
      .filter((c): c is TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }

  private extractToolNames(msg: Message): string[] {
    return msg.content
      .filter(
        (c): c is ToolUseBlock => c.type === 'tool_use',
      )
      .map((c) => c.name);
  }
}
