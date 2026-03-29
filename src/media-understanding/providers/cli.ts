import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ProviderOptions } from '../types.js';
import type { ModelEntry } from './types.js';

const execFileAsync = promisify(execFile);

export async function runCliProvider(
  entry: Extract<ModelEntry, { type: 'cli' }>,
  path: string,
  opts: ProviderOptions,
): Promise<string> {
  const args = entry.args.map((arg: string) =>
    arg
      .replace('{{MediaPath}}', path)
      .replace('{{MaxChars}}', String(opts.maxChars ?? 500)),
  );

  const { stdout } = await execFileAsync(entry.command, args, {
    timeout: (entry.timeoutSeconds ?? 60) * 1000,
  });

  return stdout.trim();
}
