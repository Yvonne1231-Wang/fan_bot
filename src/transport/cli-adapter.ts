// ─── CLI Channel Adapter ───────────────────────────────────────────────────

import { createInterface, Interface } from 'readline';
import {
  BaseChannelAdapter,
  type ChannelAdapterConfig,
  type MessageHandler,
} from './adapter.js';
import type {
  UnifiedMessage,
  UnifiedResponse,
  StreamEvent,
  ContentBlock,
  MessageContext,
} from './unified.js';
import type { SessionManager } from '../session/types.js';
import type { MemoryService, Scope } from '../memory/types.js';

/**
 * CLI 适配器配置
 */
export interface CLIAdapterConfig extends Partial<ChannelAdapterConfig> {
  /** 欢迎消息 */
  welcomeMessage?: string;

  /** 会话管理器 */
  sessionManager?: SessionManager;

  /** 会话 ID */
  sessionId?: string;

  /** 记忆服务 */
  memory?: MemoryService;

  /** 外部 readline 接口 */
  rl?: Interface;

  /** 取消回调 */
  abort?: () => void;
}

/**
 * CLI 渠道适配器
 *
 * 实现 CLI 终端的消息收发，支持：
 * - 基本的命令行交互
 * - 斜杠命令处理
 * - 流式输出
 */
export class CLIChannelAdapter extends BaseChannelAdapter {
  readonly channelType = 'cli' as const;
  readonly name = 'CLI Adapter';

  private readline: Interface | null = null;
  private cliConfig: CLIAdapterConfig;
  private currentSessionId: string;
  private sigintCount = 0;

  constructor(config: CLIAdapterConfig = {}) {
    super({ ...config, channelType: 'cli' });
    this.cliConfig = config;
    this.currentSessionId = config.sessionId || `cli-session-${Date.now()}`;
  }

  protected async doInitialize(): Promise<void> {
    this.readline =
      this.cliConfig.rl ??
      createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> ',
      });

    const welcome =
      this.cliConfig.welcomeMessage ??
      'Welcome! Type your message or "exit" to quit.';
    console.log(welcome);
    console.log('');

    this.setupSignalHandlers();
  }

  /**
   * 启动 CLI 交互循环
   *
   * 这是 CLI 适配器的核心方法，开始监听用户输入
   */
  async start(): Promise<void> {
    if (!this.readline) {
      await this.initialize();
    }

    return new Promise((resolve) => {
      this.readline!.prompt();

      this.readline!.on('line', async (line: string) => {
        const input = line.trim();

        if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
          this.readline!.close();
          return;
        }

        if (!input) {
          this.readline!.prompt();
          return;
        }

        if (input.startsWith('/')) {
          const handled = await this.handleSlashCommand(input);
          if (handled) {
            console.log('');
            this.readline!.prompt();
            return;
          }
        }

        await this.processUserInput(input);
        console.log('');
        this.readline!.prompt();
      });

      this.readline!.on('close', () => {
        console.log('\nGoodbye!');
        resolve();
      });
    });
  }

  async send(
    response: UnifiedResponse,
    _context: MessageContext,
  ): Promise<void> {
    for (const block of response.content) {
      switch (block.type) {
        case 'text':
          console.log(block.text);
          break;
        case 'markdown':
          console.log(block.text);
          break;
        case 'image':
          console.log(`[Image: ${block.url}]`);
          break;
        case 'file':
          console.log(`[File: ${block.name}]`);
          break;
        case 'card':
          if (block.title) {
            console.log(`\n=== ${block.title} ===`);
          }
          console.log(block.content);
          break;
        case 'action':
          console.log(`[Action Required: ${block.prompt}]`);
          break;
      }
    }
  }

  async sendStream(
    event: StreamEvent,
    _context: MessageContext,
  ): Promise<void> {
    switch (event.type) {
      case 'start':
        break;
      case 'delta':
        if (event.delta) {
          process.stdout.write(event.delta);
        }
        break;
      case 'done':
        process.stdout.write('\n');
        break;
      case 'error':
        console.error(`\nError: ${event.error}`);
        break;
    }
  }

  protected async doClose(): Promise<void> {
    if (this.readline && !this.cliConfig.rl) {
      this.readline.close();
    }
    this.readline = null;
  }

  /**
   * 获取当前会话 ID
   */
  getSessionId(): string {
    return this.currentSessionId;
  }

  /**
   * 设置会话 ID
   */
  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  private setupSignalHandlers(): void {
    const sigintHandler = () => {
      this.sigintCount++;
      if (this.sigintCount === 1) {
        console.log('\n[Cancelling...]');
        this.cliConfig.abort?.();
        setTimeout(() => {
          process.exit(0);
        }, 500);
      } else if (this.sigintCount >= 2) {
        process.exit(0);
      }
    };

    process.on('SIGINT', sigintHandler);
  }

  private async processUserInput(input: string): Promise<void> {
    if (!this.messageHandler) {
      console.log('No message handler configured');
      return;
    }

    const message = this.createUnifiedMessage(input);

    try {
      if (this.streamHandler && message.stream) {
        await this.streamHandler(message, (event) => {
          this.sendStream(event, message.context);
        });
      } else {
        const response = await this.messageHandler(message);
        await this.send(response, message.context);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error('Error:', errorMessage);
    }
  }

  private createUnifiedMessage(input: string): UnifiedMessage {
    const content: ContentBlock[] = [{ type: 'text', text: input }];

    return {
      id: `cli-msg-${Date.now()}`,
      context: {
        channel: 'cli',
        userId: 'cli-user',
        sessionId: this.currentSessionId,
        dmId: 'cli-dm', // CLI 模式视为私聊
        metadata: {},
      },
      content,
      timestamp: Date.now(),
      stream: true,
    };
  }

  private async handleSlashCommand(input: string): Promise<boolean> {
    const { sessionManager, memory } = this.cliConfig;
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'help':
        this.printHelp();
        return true;

      case 'sessions':
        await this.listSessions(sessionManager);
        return true;

      case 'new':
        console.log('Start a new session with: npx tsx src/index.ts');
        return true;

      case 'clear':
        await this.clearSession(sessionManager);
        return true;

      case 'status':
        this.showStatus(sessionManager);
        return true;

      case 'exit':
        console.log('Use "exit" or Ctrl+C to quit');
        return true;

      case 'remember':
        await this.handleRemember(args, memory);
        return true;

      case 'forget':
        await this.handleForget(args, memory);
        return true;

      case 'memory':
        await this.handleMemory(args, memory);
        return true;

      default:
        console.log(
          `Unknown command: /${cmd}. Type /help for available commands.`,
        );
        return true;
    }
  }

  private printHelp(): void {
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
  }

  private async listSessions(sessionManager?: SessionManager): Promise<void> {
    if (!sessionManager) {
      console.log('Session manager not available');
      return;
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
  }

  private async clearSession(sessionManager?: SessionManager): Promise<void> {
    if (!sessionManager) {
      console.log('Session manager not available');
      return;
    }
    await sessionManager.save(this.currentSessionId, []);
    console.log('Session cleared');
  }

  private showStatus(sessionManager?: SessionManager): void {
    console.log(`Session ID: ${this.currentSessionId}`);
    if (sessionManager) {
      sessionManager.load(this.currentSessionId).then((messages) => {
        console.log(`Messages: ${messages.length}`);
      });
    }
  }

  private async handleRemember(
    args: string[],
    memory?: MemoryService,
  ): Promise<void> {
    if (!memory) {
      console.log('Memory service not available');
      return;
    }
    if (args.length === 0) {
      console.log('Usage: /remember [scope:]key=value');
      console.log('  Scopes: user (default), agent, global');
      console.log('  Example: /remember agent:persona=helpful');
      return;
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
      return;
    }

    await memory.remember(memKey.trim(), memValue.trim(), rememberScope);
    console.log(
      `Saved [${rememberScope}]: ${memKey.trim()} = ${memValue.trim()}`,
    );
  }

  private async handleForget(
    args: string[],
    memory?: MemoryService,
  ): Promise<void> {
    if (!memory) {
      console.log('Memory service not available');
      return;
    }
    if (args.length === 0) {
      console.log('Usage: /forget [scope:]key');
      return;
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
  }

  private async handleMemory(
    args: string[],
    memory?: MemoryService,
  ): Promise<void> {
    if (!memory) {
      console.log('Memory service not available');
      return;
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
      return;
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
      return;
    }

    if (subCmd === 'search') {
      if (subArgs.length === 0) {
        console.log('Usage: /memory search <query>');
        return;
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
      return;
    }

    console.log(`Unknown /memory subcommand: ${subCmd}`);
    console.log('Available: list, search, stats');
  }
}

/**
 * 解析命令行参数
 *
 * @param argv - 命令行参数（默认为 process.argv.slice(2)）
 * @returns 解析后的选项
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
 * 打印帮助信息
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

/**
 * 创建 CLI 适配器的工厂函数
 *
 * @param config - CLI 适配器配置
 * @returns CLI 适配器实例
 */
export function createCLIAdapter(
  config: CLIAdapterConfig = {},
): CLIChannelAdapter {
  return new CLIChannelAdapter(config);
}
