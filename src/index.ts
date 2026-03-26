// ─── Agent Entry Point ──────────────────────────────────────────────────────

import { config } from 'dotenv';
import type { LLMClient } from './llm/types.js';

// Load environment variables
config();

import { createLLMClient, Provider } from './llm/index.js';
import { runAgent } from './agent/index.js';
import { createSessionManager, JSONLStore } from './session/index.js';
import { registry, registerTool } from './tools/registry.js';
import { calculatorTool } from './tools/calculator.js';
import {
  startCLI,
  parseArgs,
  printHelp,
  startHTTP,
  type InputHandler,
} from './transport/index.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SESSION_DIR = './sessions';
const DEFAULT_HTTP_PORT = 3000;

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  // Determine transport type
  const transport = process.env.TRANSPORT || 'cli';

  if (transport === 'http') {
    await startHTTPServer();
  } else {
    await startCLITransport(args.sessionId, args.provider);
  }
}

/**
 * Start HTTP server.
 */
async function startHTTPServer(): Promise<void> {
  const port = Number(process.env.HTTP_PORT) || DEFAULT_HTTP_PORT;

  console.log('Starting HTTP server...');
  console.log(`Port: ${port}`);

  // Note: Full HTTP implementation requires Fastify
  // This is a placeholder that shows the architecture
  await startHTTP({ port });
}

/**
 * Start CLI transport.
 */
async function startCLITransport(sessionId?: string, providerName?: string): Promise<void> {
  // Setup dependencies
  const llmClient = createLLMClientFromEnv(providerName);
  const sessionManager = createSessionManager({
    store: new JSONLStore({ dir: DEFAULT_SESSION_DIR }),
    maxContextMessages: 40,
  });

  // Register tools
  registerTool(calculatorTool);

  // Load existing session or create new
  const sid = sessionId || `session-${Date.now()}`;
  const initialMessages = await sessionManager.load(sid);

  if (initialMessages.length > 0) {
    console.log(`Loaded session: ${sid}`);
    console.log(`Messages: ${initialMessages.length}`);
    console.log('');
  }

  // Create input handler
  const handler: InputHandler = async (input) => {
    // Load current messages
    const messages = await sessionManager.load(sid);

    // Run agent
    const result = await runAgent({
      prompt: input,
      llmClient,
      toolRegistry: registry,
      initialMessages: messages,
      maxIterations: 10,
    });

    // Save updated messages
    await sessionManager.save(sid, result.messages);

    return result.response;
  };

  // Start CLI
  await startCLI(handler, {
    sessionId: sid,
    welcomeMessage: `Agent CLI\nSession: ${sid}\nType "exit" to quit.`,
  });
}

/**
 * Create LLM client from environment variables.
 */
function createLLMClientFromEnv(providerName?: string): LLMClient {
  const provider = providerName || process.env.LLM_PROVIDER || 'anthropic';

  if (provider === 'ark') {
    const apiKey = process.env.ARK_API_KEY;
    if (!apiKey) {
      throw new Error('ARK_API_KEY environment variable is required');
    }

    return createLLMClient({
      provider: Provider.Ark,
      apiKey,
      baseURL: process.env.ARK_BASE_URL,
      model: process.env.ARK_MODEL,
    });
  }

  // Default to Anthropic
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  return createLLMClient({
    provider: Provider.Anthropic,
    apiKey,
    model: process.env.ANTHROPIC_MODEL,
  });
}

// ─── Start Application ──────────────────────────────────────────────────────

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
