// ─── Agent Entry Point ──────────────────────────────────────────────────────

import { config } from 'dotenv';

config();

import { parseArgs, printHelp } from './transport/index.js';
import { loadSkills } from './bootstrap/index.js';
import { startHTTPServer } from './bootstrap/http.js';
import { startFeishuAdapter } from './bootstrap/feishu.js';
import { startCLIAdapter } from './bootstrap/cli.js';

/**
 * 主入口函数
 */
async function main(): Promise<void> {
  await loadSkills();

  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  const transport = process.env.TRANSPORT || 'cli';

  switch (transport) {
    case 'http':
      await startHTTPServer();
      break;
    case 'feishu':
      await startFeishuAdapter();
      break;
    default:
      await startCLIAdapter(args.sessionId, args.provider);
  }
}

// ─── Start Application ──────────────────────────────────────────────────────

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
