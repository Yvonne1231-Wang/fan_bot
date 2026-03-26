// ─── CLI Transport ──────────────────────────────────────────────────────────

import { createInterface } from 'readline';
import type { CLITransportOptions } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Handler for user input.
 */
export type InputHandler = (input: string) => Promise<string | void>;

// ─── CLI Implementation ─────────────────────────────────────────────────────

/**
 * Start CLI REPL.
 *
 * @param handler - Input handler function
 * @param options - CLI options
 * @returns Promise that resolves when CLI exits
 */
export async function startCLI(
  handler: InputHandler,
  options: CLITransportOptions = {}
): Promise<void> {
  const { welcomeMessage = 'Welcome! Type your message or "exit" to quit.' } = options;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  console.log(welcomeMessage);
  console.log('');

  return new Promise((resolve) => {
    rl.prompt();

    rl.on('line', async (line) => {
      const input = line.trim();

      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        rl.close();
        return;
      }

      if (!input) {
        rl.prompt();
        return;
      }

      try {
        const response = await handler(input);
        if (response) {
          console.log(response);
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
      }

      console.log('');
      rl.prompt();
    });

    rl.on('close', () => {
      console.log('\nGoodbye!');
      resolve();
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      rl.close();
    });
  });
}

/**
 * Parse CLI arguments.
 *
 * @param argv - Command line arguments (defaults to process.argv.slice(2))
 * @returns Parsed options
 */
export function parseArgs(
  argv: string[] = process.argv.slice(2)
): { sessionId?: string; provider?: string; help: boolean } {
  let sessionId: string | undefined;
  let provider: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--session' || arg === '-s') {
      sessionId = argv[++i];
    } else if (arg === '--provider' || arg === '-p') {
      provider = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    }
  }

  return { sessionId, provider, help };
}

/**
 * Print help message.
 */
export function printHelp(): void {
  console.log(`
Agent CLI

Usage:
  npx tsx src/index.ts [options]

Options:
  -s, --session <id>     Session ID to use (creates new if not provided)
  -p, --provider <name>  LLM provider (anthropic or ark)
  -h, --help            Show this help message

Environment Variables:
  TRANSPORT=cli|http    Transport type (default: cli)
  LLM_PROVIDER          Default LLM provider
  ANTHROPIC_API_KEY     Anthropic API key
  ARK_API_KEY          Ark API key
  ARK_BASE_URL         Ark base URL
  ARK_MODEL            Ark model ID

Examples:
  # Start CLI with new session
  npx tsx src/index.ts

  # Continue existing session
  npx tsx src/index.ts --session my-session

  # Use specific provider
  npx tsx src/index.ts --provider ark
`);
}
