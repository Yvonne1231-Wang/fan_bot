// ─── CLI Transport ──────────────────────────────────────────────────────────

import { createInterface } from 'readline';
import type { CLITransportOptions } from './types.js';
import type { SessionManager } from '../session/types.js';
import type { MemoryService, Scope } from '../memory/types.js';

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
  /help              Show this help message
  /sessions          List recent sessions
  /new               Start a new session
  /clear             Clear current session messages
  /status            Show current session info
  /remember <k=v>    Store a fact in memory
                     Format: [scope:]key=value
                     Scopes: user (default), agent, global
                     Example: /remember agent:persona=helpful
  /forget <key>      Delete a fact from memory
                     Format: [scope:]key
  /memory            Show memory stats
  /memory list [scope]     List all memories (optionally by scope)
  /memory search <query>   Semantic search memories
  /memory delete <id>      Delete memory by ID
  /memory stats            Show memory statistics
  /memory history <key>   Show history of a key (all versions)
                     Example: /memory history job
  /exit              Exit the program
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
        console.log('Usage: /remember [scope:]key=value');
        console.log('  Scopes: user (default), agent, global');
        console.log('  Example: /remember agent:persona=helpful');
        return true;
      }
      const rememberInput = args.join(' ');
      let rememberScope: Scope = 'user';
      let rememberKV = rememberInput;

      if (rememberInput.includes(':') && !rememberInput.startsWith(':')) {
        const [scopePart, ...rest] = rememberInput.split(':');
        if (
          scopePart === 'user' ||
          scopePart === 'agent' ||
          scopePart === 'global'
        ) {
          rememberScope = scopePart;
          rememberKV = rest.join(':');
        }
      }

      const [memKey, ...memValParts] = rememberKV.split('=');
      const memValue = memValParts.join('=');
      if (!memKey || !memValue) {
        console.log('Usage: /remember [scope:]key=value');
        return true;
      }

      const record = await memory.remember(
        memKey.trim(),
        memValue.trim(),
        rememberScope,
      );
      console.log(
        `Saved [${rememberScope}]: ${memKey.trim()} = ${memValue.trim()}`,
      );
      console.log(`  ID: ${record.id}`);
      return true;

    case 'forget':
      if (!memory) {
        console.log('Memory service not available');
        return true;
      }
      if (args.length === 0) {
        console.log('Usage: /forget [scope:]key');
        return true;
      }
      const forgetInput = args.join(' ');
      let forgetScope: Scope | undefined;
      let forgetKey = forgetInput;

      if (forgetInput.includes(':') && !forgetInput.startsWith(':')) {
        const [scopePart, ...rest] = forgetInput.split(':');
        if (
          scopePart === 'user' ||
          scopePart === 'agent' ||
          scopePart === 'global'
        ) {
          forgetScope = scopePart;
          forgetKey = rest.join(':');
        }
      }

      await memory.forget(forgetKey.trim(), forgetScope);
      console.log(
        `Deleted: ${forgetKey.trim()}${forgetScope ? ` (scope: ${forgetScope})` : ''}`,
      );
      return true;

    case 'memory':
      if (!memory) {
        console.log('Memory service not available');
        return true;
      }

      const subCmd = args[0]?.toLowerCase();
      const subArgs = args.slice(1);

      if (!subCmd || subCmd === 'stats') {
        const stats = await memory.stats();
        console.log('Memory Statistics:');
        console.log(`  user:   ${stats.user} memories`);
        console.log(`  agent:  ${stats.agent} memories`);
        console.log(`  global: ${stats.global} memories`);
        console.log(
          `  Total:  ${stats.user + stats.agent + stats.global} memories`,
        );
        return true;
      }

      if (subCmd === 'list') {
        const listScopeArg = subArgs[0];
        let listScope: Scope | undefined;
        if (
          listScopeArg === 'user' ||
          listScopeArg === 'agent' ||
          listScopeArg === 'global'
        ) {
          listScope = listScopeArg;
        }

        const records = await memory.listAll(listScope);
        if (records.length === 0) {
          console.log(
            `No memories stored${listScope ? ` in scope '${listScope}'` : ''}.`,
          );
        } else {
          console.log(`Stored memories${listScope ? ` (${listScope})` : ''}:`);
          for (const r of records) {
            const date = new Date(r.updatedAt).toLocaleDateString();
            console.log(`  [${r.scope}] ${r.key}: ${r.value}`);
            console.log(`      ID: ${r.id} | Updated: ${date}`);
          }
        }
        return true;
      }

      if (subCmd === 'search') {
        if (subArgs.length === 0) {
          console.log('Usage: /memory search <query>');
          return true;
        }
        const searchQuery = subArgs.join(' ');
        console.log(`Searching for: "${searchQuery}"...`);
        const results = await memory.searchAdvanced(searchQuery, {
          topK: 10,
          rerank: true,
        });
        if (results.length === 0) {
          console.log('No results found.');
        } else {
          console.log(`Found ${results.length} results:`);
          for (const r of results) {
            console.log(`  [${r.scope}] ${r.key}: ${r.value}`);
            console.log(`      Score: ${r.score.toFixed(3)} | ID: ${r.id}`);
          }
        }
        return true;
      }

      if (subCmd === 'delete') {
        if (subArgs.length === 0) {
          console.log('Usage: /memory delete <id>');
          return true;
        }
        const deleteId = subArgs[0];
        const existing = await memory.getById(deleteId);
        if (!existing) {
          console.log(`Memory not found: ${deleteId}`);
          return true;
        }
        await memory.deleteById(deleteId);
        console.log(
          `Deleted: [${existing.scope}] ${existing.key}: ${existing.value}`,
        );
        return true;
      }

      if (subCmd === 'history') {
        if (subArgs.length === 0) {
          console.log('Usage: /memory history <key>');
          console.log('  Show all versions of a key');
          return true;
        }
        const historyKey = subArgs[0];
        const records = await memory.getHistory(historyKey);
        if (records.length === 0) {
          console.log(`No history found for key: ${historyKey}`);
          return true;
        }
        console.log(`History for "${historyKey}":`);
        for (const r of records) {
          const date = new Date(r.updatedAt).toLocaleDateString();
          console.log(`  [${r.scope}] ${r.key}: ${r.value}`);
          console.log(
            `      Valid: ${new Date(r.validFrom).toLocaleDateString()} - ${r.validUntil ? new Date(r.validUntil).toLocaleDateString() : 'present'}`,
          );
          console.log(`      ID: ${r.id} | Updated: ${date}`);
        }
        return true;
      }

      console.log(`Unknown /memory subcommand: ${subCmd}`);
      console.log('Available: list, search, delete, history, stats');
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
