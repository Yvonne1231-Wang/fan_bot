import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { MediaUnderstandingOutput, MediaConfig } from './types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('media:cache');

interface CacheStore {
  version: 1;
  entries: Record<string, CacheEntry>;
}

interface CacheEntry {
  output: Omit<MediaUnderstandingOutput, 'cached' | 'durationMs'>;
  createdAt: number;
}

export async function readCache(
  key: string,
  config?: MediaConfig['cache']
): Promise<MediaUnderstandingOutput | null> {
  if (config?.enabled === false) return null;

  try {
    const store = await loadStore(config);
    const entry = store.entries[key];
    if (!entry) return null;

    const ttlMs = (config?.ttlDays ?? 30) * 24 * 60 * 60 * 1000;
    if (Date.now() - entry.createdAt > ttlMs) {
      return null;
    }

    log.debug('Cache hit', { key });
    return {
      ...entry.output,
      cached: true,
      durationMs: 0,
    };
  } catch (err) {
    log.debug('Cache read error', { key, error: String(err) });
    return null;
  }
}

export async function writeCache(
  key: string,
  output: MediaUnderstandingOutput,
  config?: MediaConfig['cache']
): Promise<void> {
  if (config?.enabled === false) return;

  try {
    const store = await loadStore(config);

    const maxEntries = config?.maxEntries ?? 10000;
    const keys = Object.keys(store.entries);
    if (keys.length >= maxEntries) {
      const sorted = keys.sort((a, b) => store.entries[a].createdAt - store.entries[b].createdAt);
      const toDelete = sorted.slice(0, Math.floor(maxEntries * 0.1));
      toDelete.forEach((k) => delete store.entries[k]);
    }

    store.entries[key] = {
      output: {
        capability: output.capability,
        text: output.text,
        provider: output.provider,
        model: output.model,
      },
      createdAt: Date.now(),
    };

    await saveStore(store, config);
    log.debug('Cache written', { key });
  } catch (err) {
    log.debug('Cache write error', { key, error: String(err) });
  }
}

async function loadStore(config?: MediaConfig['cache']): Promise<CacheStore> {
  const path = resolveStorePath(config);
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as CacheStore;
  } catch {
    return { version: 1, entries: {} };
  }
}

async function saveStore(store: CacheStore, config?: MediaConfig['cache']): Promise<void> {
  const path = resolveStorePath(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store), 'utf8');
}

function resolveStorePath(config?: MediaConfig['cache']): string {
  const appName = process.env.APP_NAME ?? 'fan_bot';
  return config?.storagePath ?? `${process.env.HOME}/.${appName}/media-cache.json`;
}
