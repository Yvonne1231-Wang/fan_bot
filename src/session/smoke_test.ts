// ─── Session Smoke Test ───────────────────────────────────────────────────

import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { JSONLStore } from './store.js';
import { createSessionManager } from './manager.js';
import type { Message } from '../llm/types.js';

// ─── Test Configuration ─────────────────────────────────────────────────────

const TEST_DIR = join(process.cwd(), 'test-sessions');

// ─── Test Utilities ─────────────────────────────────────────────────────────

/**
 * Create test messages.
 */
function createTestMessages(): Message[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
    { role: 'user', content: [{ type: 'text', text: 'How are you?' }] },
  ];
}

/**
 * Setup test environment.
 */
async function setup(): Promise<void> {
  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
  await mkdir(TEST_DIR, { recursive: true });
}

/**
 * Cleanup test environment.
 */
async function cleanup(): Promise<void> {
  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

// ─── Test Functions ───────────────────────────────────────────────────────

/**
 * Test JSONL store basic operations.
 */
async function testJSONLStore(): Promise<void> {
  console.log('Test 1: JSONL Store Operations');
  console.log('-'.repeat(40));

  const store = new JSONLStore({ dir: TEST_DIR });
  const messages = createTestMessages();

  // Test save
  const session = {
    meta: {
      id: 'test-session-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: messages.length,
    },
    messages,
  };

  await store.save(session);
  console.log('✓ Session saved');

  // Test load
  const loaded = await store.load('test-session-1');
  if (!loaded) {
    throw new Error('Failed to load session');
  }
  console.log('✓ Session loaded');
  console.log(`  Messages: ${loaded.messages.length}`);

  // Test list
  const list = await store.list();
  if (list.length !== 1) {
    throw new Error(`Expected 1 session, got ${list.length}`);
  }
  console.log('✓ Session list retrieved');

  // Test delete
  await store.delete('test-session-1');
  const afterDelete = await store.load('test-session-1');
  if (afterDelete !== null) {
    throw new Error('Session should be deleted');
  }
  console.log('✓ Session deleted');

  console.log('✅ JSONL Store test passed\n');
}

/**
 * Test SessionManager.
 */
async function testSessionManager(): Promise<void> {
  console.log('Test 2: Session Manager');
  console.log('-'.repeat(40));

  const store = new JSONLStore({ dir: TEST_DIR });
  const manager = createSessionManager({
    store,
    maxContextMessages: 10,
  });

  const sessionId = 'manager-test-session';

  // Test empty load (new session)
  const empty = await manager.load(sessionId);
  if (empty.length !== 0) {
    throw new Error('New session should be empty');
  }
  console.log('✓ Empty session created');

  // Test save and reload
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
  ];

  await manager.save(sessionId, messages);
  const loaded = await manager.load(sessionId);

  if (loaded.length !== 2) {
    throw new Error(`Expected 2 messages, got ${loaded.length}`);
  }
  console.log('✓ Session saved and reloaded');

  // Test list
  const list = await manager.list();
  if (list.length !== 1) {
    throw new Error(`Expected 1 session in list, got ${list.length}`);
  }
  console.log('✓ Session list working');

  // Test delete
  await manager.delete(sessionId);
  const afterDelete = await manager.load(sessionId);
  if (afterDelete.length !== 0) {
    throw new Error('Session should be empty after delete');
  }
  console.log('✓ Session deleted');

  console.log('✅ Session Manager test passed\n');
}

/**
 * Test message pruning.
 */
async function testPruning(): Promise<void> {
  console.log('Test 3: Message Pruning');
  console.log('-'.repeat(40));

  const store = new JSONLStore({ dir: TEST_DIR });
  const manager = createSessionManager({
    store,
    maxContextMessages: 5, // Small limit for testing
  });

  // Create many messages
  const messages: Message[] = [
    // First message (system-like, should be preserved)
    { role: 'user', content: [{ type: 'text', text: 'System prompt' }] },
  ];

  // Add more messages
  for (let i = 0; i < 10; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `Message ${i}` }],
    });
  }

  console.log(`Created ${messages.length} messages`);

  // Prune
  const pruned = manager.prune(messages);
  console.log(`Pruned to ${pruned.length} messages`);

  // Verify first message is preserved
  const firstText = (pruned[0]?.content[0] as { type: 'text'; text: string })
    ?.text;
  if (firstText !== 'System prompt') {
    throw new Error('First message should be preserved');
  }
  console.log('✓ First message preserved');

  // Verify we have the right count
  if (pruned.length !== 5) {
    throw new Error(`Expected 5 messages after prune, got ${pruned.length}`);
  }
  console.log('✓ Correct message count');

  console.log('✅ Pruning test passed\n');
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Run all smoke tests.
 */
async function runSmokeTests(): Promise<void> {
  console.log('Running Session smoke tests...\n');

  try {
    await setup();

    await testJSONLStore();
    await testSessionManager();
    await testPruning();

    console.log('✅ All Session smoke tests passed!\n');
  } catch (error) {
    console.error('\n❌ Smoke test failed:', error);
    throw error;
  } finally {
    await cleanup();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSmokeTests().catch(() => process.exit(1));
}
