import type { MediaProvider } from './types.js';
import { anthropicProvider } from './anthropic.js';
import { openaiProvider } from './openai.js';

const providers: Record<string, MediaProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  ark: openaiProvider,
};

export function getProvider(name: string): MediaProvider | undefined {
  return providers[name];
}

export function getAllProviders(): MediaProvider[] {
  return Object.values(providers);
}

export { anthropicProvider, openaiProvider };
