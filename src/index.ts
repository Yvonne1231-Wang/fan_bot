// ─── Agent Entry Point ──────────────────────────────────────────────────────

import { config } from 'dotenv';
import type { LLMClient } from './llm/types.js';

// Load environment variables
config();

import { createInterface } from 'readline';
import { createLLMClientFromEnv } from './llm/index.js';
import {
  runAgent,
  buildSystemPrompt,
  createPlan,
  shouldPlan,
} from './agent/index.js';
import { createSessionManager, JSONLStore } from './session/index.js';
import { getMemory } from './memory/index.js';
import { registry, registerTool } from './tools/registry.js';
import { calculatorTool } from './tools/calculator.js';
import { readFileTool, writeFileTool, listDirTool } from './tools/files.js';
import { shellTool } from './tools/shell.js';
import { webSearchTool } from './tools/web_search.js';
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
  const llmClient = createLLMClientFromEnv();
  const sessionManager = createSessionManager({
    store: new JSONLStore({ dir: DEFAULT_SESSION_DIR }),
    maxContextMessages: 40,
  });

  registerTool(calculatorTool);
  registerTool(readFileTool);
  registerTool(writeFileTool);
  registerTool(listDirTool);
  registerTool(shellTool);
  registerTool(webSearchTool);

  await startHTTP({
    port,
    chatHandler: async ({ sessionId, message }) => {
      const sid = sessionId || `session-${Date.now()}`;
      const messages = await sessionManager.load(sid);
      const memory = getMemory();

      const result = await runAgent({
        prompt: message,
        llmClient,
        toolRegistry: registry,
        initialMessages: messages,
        maxIterations: 100,
        systemPrompt: await buildSystemPrompt({
          agentName: 'fan_bot',
          memory,
          userQuery: message,
        }),
      });

      const prunedMessages = sessionManager.prune(result.messages);
      await sessionManager.save(sid, prunedMessages);

      return {
        response: result.response,
        sessionId: sid,
        iterations: result.iterations,
        usage: result.usage,
      };
    },
    sessionListHandler: async () => {
      const sessions = await sessionManager.list();
      return { sessions };
    },
  });
}

/**
 * Start CLI transport.
 */
async function startCLITransport(
  sessionId?: string,
  providerName?: string,
): Promise<void> {
  // Setup dependencies
  const llmClient = createLLMClientFromEnv(providerName);
  const sessionManager = createSessionManager({
    store: new JSONLStore({ dir: DEFAULT_SESSION_DIR }),
    maxContextMessages: 40,
  });

  // Register tools
  registerTool(calculatorTool);
  registerTool(readFileTool);
  registerTool(writeFileTool);
  registerTool(listDirTool);
  registerTool(shellTool);
  registerTool(webSearchTool);

  // Load existing session or create new
  const sid = sessionId || `session-${Date.now()}`;
  const initialMessages = await sessionManager.load(sid);

  if (initialMessages.length > 0) {
    console.log(`Loaded session: ${sid}`);
    console.log(`Messages: ${initialMessages.length}`);
    console.log('');
  }

  // Create input handler
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let abortController: AbortController | null = null;

  const confirmFn = async (preview: string): Promise<boolean> => {
    return new Promise((resolve) => {
      rl.question(`\n[confirm] ${preview}\nProceed? [y/N] `, (answer) => {
        resolve(answer.toLowerCase() === 'y');
      });
    });
  };

  const handler: InputHandler = async (input) => {
    abortController = new AbortController();
    const messages = await sessionManager.load(sid);
    const memory = getMemory();

    const systemPrompt = await buildSystemPrompt({
      agentName: 'fan_bot',
      memory,
      userQuery: input,
    });

    if (shouldPlan(input)) {
      console.log('[Planner] Creating task breakdown...');
      const plan = await createPlan(input, llmClient);

      console.log('\n[Planner] Task breakdown:');
      plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.title}`));

      const confirmed = await confirmFn('Execute this plan? [y/N] ');
      if (!confirmed) {
        console.log('Plan cancelled.');
        return 'Okay, cancelled.';
      }

      let lastResult = '';
      for (const step of plan.steps) {
        console.log(
          `\n[Step ${step.index + 1}/${plan.steps.length}] ${step.title}`,
        );
        step.status = 'running';

        const result = await runAgent({
          prompt: `${step.title}\n\nContext from previous steps:\n${lastResult}`,
          llmClient,
          toolRegistry: registry,
          initialMessages: messages,
          maxIterations: 100,
          systemPrompt,
          confirmFn,
          abortSignal: abortController?.signal,
        });

        step.status = 'done';
        step.result = result.response;
        lastResult = result.response;

        const prunedMessages = sessionManager.prune(result.messages);
        await sessionManager.save(sid, prunedMessages);
      }

      console.log('\n[Planner] Plan complete.');
      return `Plan complete.\n\nFinal result:\n${lastResult}`;
    }

    const result = await runAgent({
      prompt: input,
      llmClient,
      toolRegistry: registry,
      initialMessages: messages,
      maxIterations: 100,
      systemPrompt,
      onText: (delta) => process.stdout.write(delta),
      confirmFn,
      abortSignal: abortController?.signal,
    });

    const prunedMessages = sessionManager.prune(result.messages);
    await sessionManager.save(sid, prunedMessages);

    return '';
  };

  // Start CLI
  const memory = getMemory();
  await startCLI(handler, {
    sessionId: sid,
    welcomeMessage: `Agent CLI\nSession: ${sid}\nType "exit" to quit.`,
    sessionManager,
    memory,
    rl,
    abort: () => abortController?.abort(),
  });
}

// ─── Start Application ──────────────────────────────────────────────────────

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
