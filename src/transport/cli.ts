// ─── CLI Transport ──────────────────────────────────────────────────────────

import { createInterface } from 'readline';
import type { CLITransportOptions } from './types.js';
import type { SessionManager } from '../session/types.js';
import type { MemoryService } from '../memory/types.js';

export type InputHandler = (input: string) => Promise<string | void>;

async function handleSlashCommand(
  input: string,
  context: {
    sessionManager?: SessionManager;
    sessionId?: string;
    memory?: MemoryService;
  },
): Promise<boolean> {
  const { sessionManager, sessionId, memory } = context;
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case 'help':
      console.log(`
Available commands:
  /help           Show this help message
  /sessions       List recent sessions
  /new            Start a new session
  /clear          Clear current session messages
  /status         Show current session info
  /remember <k=v> Store a fact in memory
  /forget <key>   Delete a fact from memory
  /memory         List all stored facts
  /exit           Exit the program
`);
      return true;

    case 'sessions':
      if (!sessionManager) {
        console.log('Session manager not available');
        return true;
      }
      const sessions = await sessionManager.list();
      if (sessions.length === 0) {
        console.log('No sessions found');
      } else {
        console.log('Recent sessions:');
        for (const s of sessions.slice(0, 10)) {
          const date = new Date(s.updatedAt).toLocaleString();
          console.log(`  ${s.id} - ${s.messageCount} messages (${date})`);
        }
      }
      return true;

    case 'new':
      console.log('Start a new session with: npx tsx src/index.ts');
      return true;

    case 'clear':
      if (!sessionManager || !sessionId) {
        console.log('Session manager not available');
        return true;
      }
      await sessionManager.save(sessionId, []);
      console.log('Session cleared');
      return true;

    case 'status':
      if (!sessionManager || !sessionId) {
        console.log('Session manager not available');
        return true;
      }
      const messages = await sessionManager.load(sessionId);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Messages: ${messages.length}`);
      return true;

    case 'exit':
      console.log('Use "exit" or Ctrl+C to quit');
      return true;

    case 'remember':
      if (!memory) {
        console.log('Memory service not available');
        return true;
      }
      if (args.length === 0) {
        console.log('Usage: /remember <key>=<value>');
        return true;
      }
      const [memKey, ...memValParts] = args.join(' ').split('=');
      const memValue = memValParts.join('=');
      if (!memKey || !memValue) {
        console.log('Usage: /remember <key>=<value>');
        return true;
      }
      await memory.setFact(memKey.trim(), memValue.trim());
      console.log(`Saved: ${memKey.trim()} = ${memValue.trim()}`);
      return true;

    case 'forget':
      if (!memory) {
        console.log('Memory service not available');
        return true;
      }
      if (args.length === 0) {
        console.log('Usage: /forget <key>');
        return true;
      }
      const delKey = args.join(' ');
      await memory.deleteFact(delKey.trim());
      console.log(`Deleted: ${delKey.trim()}`);
      return true;

    case 'memory':
      if (!memory) {
        console.log('Memory service not available');
        return true;
      }
      const facts = await memory.listFacts();
      if (facts.length === 0) {
        console.log(
          'No facts stored. Use /remember <key>=<value> to store facts.',
        );
      } else {
        console.log('Stored facts:');
        for (const f of facts) {
          console.log(`  ${f.key}: ${f.value}`);
        }
      }
      return true;

    default:
      console.log(
        `Unknown command: /${cmd}. Type /help for available commands.`,
      );
      return true;
  }
}

export async function startCLI(
  handler: InputHandler,
  options: CLITransportOptions = {},
): Promise<void> {
  const {
    welcomeMessage = 'Welcome! Type your message or "exit" to quit.',
    sessionManager,
    sessionId,
    memory,
    rl,
    abort,
  } = options;

  const readline =
    rl ??
    createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

  console.log(welcomeMessage);
  console.log('');

  return new Promise((resolve) => {
    readline.prompt();

    readline.on('line', async (line: string) => {
      const input = line.trim();

      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        readline.close();
        return;
      }

      if (!input) {
        readline.prompt();
        return;
      }

      if (input.startsWith('/')) {
        const handled = await handleSlashCommand(input, {
          sessionManager,
          sessionId,
          memory,
        });
        if (handled) {
          console.log('');
          readline.prompt();
          return;
        }
      }

      try {
        const response = await handler(input);
        if (response) {
          console.log(response);
        }
      } catch (error) {
        console.error(
          'Error:',
          error instanceof Error ? error.message : String(error),
        );
      }

      console.log('');
      readline.prompt();
    });

    readline.on('close', () => {
      console.log('\nGoodbye!');
      resolve();
    });

    let sigintCount = 0;
    const sigintHandler = () => {
      sigintCount++;
      if (sigintCount === 1) {
        console.log('\n[Cancelling...]');
        abort?.();
        setTimeout(() => {
          process.exit(0);
        }, 500);
      } else if (sigintCount >= 2) {
        process.exit(0);
      }
    };

    process.on('SIGINT', sigintHandler);
  });
}

/**
 * Parse CLI arguments.
 *
 * @param argv - Command line arguments (defaults to process.argv.slice(2))
 * @returns Parsed options
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): {
  sessionId?: string;
  provider?: string;
  help: boolean;
} {
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
