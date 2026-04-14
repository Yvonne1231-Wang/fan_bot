import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionArchive } from './archive.js';
import type { Message } from '../llm/types.js';
import { existsSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';

const TEST_DB = join('.fan_bot', 'test_archive.db');

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: [{ type: 'text' as const, text: `message number ${i}: discussing topic-${i}` }],
  }));
}

function makeToolMessage(): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me run that command' },
      { type: 'tool_use', id: 'tool_1', name: 'bash', input: { command: 'ls' } },
    ],
  };
}

describe('session/archive SessionArchive', () => {
  let archive: SessionArchive;

  beforeEach(() => {
    // Clean up any leftover test DB
    for (const suffix of ['', '-wal', '-shm']) {
      const f = TEST_DB + suffix;
      if (existsSync(f)) unlinkSync(f);
    }
    archive = new SessionArchive(TEST_DB);
  });

  afterEach(() => {
    archive.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = TEST_DB + suffix;
      if (existsSync(f)) unlinkSync(f);
    }
  });

  // ─── archive() ────────────────────────────────────────────────────────

  it('archives messages and reports correct stats', () => {
    const msgs = makeMessages(5);
    archive.archive('sess-1', msgs, 'user-a');

    const stats = archive.stats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalMessages).toBe(5);
  });

  it('skips empty-content messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: '   ' }] }, // whitespace only
    ];
    archive.archive('sess-2', msgs);

    const stats = archive.stats();
    expect(stats.totalMessages).toBe(1); // only the non-empty one
  });

  it('ignores duplicate archives (INSERT OR IGNORE)', () => {
    const msgs = makeMessages(3);
    archive.archive('sess-3', msgs, 'user-b');
    archive.archive('sess-3', msgs, 'user-b'); // duplicate

    const stats = archive.stats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalMessages).toBe(3);
  });

  it('archives multiple sessions', () => {
    archive.archive('sess-a', makeMessages(3), 'user-x');
    archive.archive('sess-b', makeMessages(4), 'user-x');

    const stats = archive.stats();
    expect(stats.totalSessions).toBe(2);
    expect(stats.totalMessages).toBe(7);
  });

  // ─── search() ─────────────────────────────────────────────────────────

  it('finds messages by keyword search', () => {
    archive.archive('sess-search', makeMessages(10));

    const results = archive.search('topic');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sessionId).toBe('sess-search');
    expect(results[0].content).toContain('topic');
  });

  it('filters by userId', () => {
    archive.archive('sess-u1', makeMessages(5), 'alice');
    archive.archive('sess-u2', makeMessages(5), 'bob');

    const results = archive.search('message', { userId: 'alice' });
    for (const r of results) {
      expect(r.sessionId).toBe('sess-u1');
    }
  });

  it('respects limit option', () => {
    archive.archive('sess-limit', makeMessages(20));

    const results = archive.search('message', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('returns empty array for non-matching query', () => {
    archive.archive('sess-miss', makeMessages(5));

    const results = archive.search('xyzzy_nonexistent_term');
    expect(results).toEqual([]);
  });

  it('handles FTS5 syntax errors gracefully', () => {
    archive.archive('sess-err', makeMessages(3));

    // Unbalanced quotes cause FTS5 syntax error
    const results = archive.search('"unclosed');
    expect(results).toEqual([]);
  });

  // ─── getSession() ─────────────────────────────────────────────────────

  it('retrieves all messages for a session in order', () => {
    const msgs = makeMessages(5);
    archive.archive('sess-get', msgs);

    const results = archive.getSession('sess-get');
    expect(results.length).toBe(5);
    expect(results[0].messageIndex).toBe(0);
    expect(results[4].messageIndex).toBe(4);
    expect(results[0].role).toBe('user');
    expect(results[1].role).toBe('assistant');
  });

  it('returns empty for unknown session', () => {
    const results = archive.getSession('nonexistent');
    expect(results).toEqual([]);
  });

  // ─── tool names extraction ────────────────────────────────────────────

  it('indexes tool names from messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'run a command' }] },
      makeToolMessage(),
    ];
    archive.archive('sess-tools', msgs);

    // Search for the tool name via FTS5
    const results = archive.search('bash');
    expect(results.length).toBeGreaterThan(0);
  });

  // ─── cleanup() ────────────────────────────────────────────────────────

  it('removes messages older than specified days', () => {
    archive.archive('sess-old', makeMessages(5));

    // With a large maxAgeDays (e.g. 365), recent messages should NOT be deleted
    const deleted = archive.cleanup(365);
    expect(deleted).toBe(0);

    const stats = archive.stats();
    expect(stats.totalMessages).toBe(5);
  });

  it('cleanup with negative days deletes everything', () => {
    archive.archive('sess-neg', makeMessages(3));
    // -1 day means cutoff = Date.now() + 86400000 → everything is older
    const deleted = archive.cleanup(-1);
    expect(deleted).toBe(3);
    expect(archive.stats().totalMessages).toBe(0);
  });

  // ─── stats() ──────────────────────────────────────────────────────────

  it('returns zero stats for empty archive', () => {
    const stats = archive.stats();
    expect(stats.totalSessions).toBe(0);
    expect(stats.totalMessages).toBe(0);
  });
});
