import { createHash } from 'crypto';
import { createReadStream, statSync } from 'fs';
import { readFile } from 'fs/promises';
import type {
  MsgContext,
  MediaConfig,
  MediaUnderstandingResult,
  MediaCapability,
  AttachmentDecision,
  MediaUnderstandingOutput,
  CapabilityConfig,
} from './types.js';
import { passesScope } from './scope.js';
import { resolveModelEntries } from './resolve.js';
import { readCache, writeCache } from './cache.js';
import { acquireAudioSemaphore, releaseAudioSemaphore } from './concurrency.js';
import { getProvider } from './providers/index.js';
import { runCliProvider } from './providers/cli.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('media:runner');

export async function runMediaUnderstanding(
  ctx: MsgContext,
  config: MediaConfig,
): Promise<MediaUnderstandingResult> {
  const result: MediaUnderstandingResult = { outputs: [], decisions: [] };

  if (!ctx.MediaPaths?.length && !ctx.MediaUrls?.length) {
    return result;
  }

  const capabilities: MediaCapability[] = ['image', 'audio', 'video'];

  for (const capability of capabilities) {
    const capConfig = config[capability];

    if (capConfig?.enabled === false) continue;

    if (!passesScope(ctx, capability, config.scope)) continue;

    const attachments = selectAttachments(ctx, capability, capConfig);
    if (!attachments.length) continue;

    for (const attachmentPath of attachments) {
      const decision = await processAttachment(
        attachmentPath,
        capability,
        capConfig ?? {},
        config,
      );
      result.decisions.push(decision);
      if (decision.finalResult) {
        result.outputs.push(decision.finalResult);
      }
    }
  }

  return result;
}

async function processAttachment(
  path: string,
  capability: MediaCapability,
  capConfig: CapabilityConfig,
  globalConfig: MediaConfig,
): Promise<AttachmentDecision> {
  const decision: AttachmentDecision = {
    attachmentPath: path,
    capability,
    attempts: [],
    finalResult: null,
  };

  const contentHash = await computeContentHash(path);
  const cacheKey = `${capability}:${contentHash}`;

  const cached = await readCache(cacheKey, globalConfig.cache);
  if (cached) {
    decision.finalResult = { ...cached, cached: true };
    decision.attempts.push({
      provider: 'cache',
      model: 'cache',
      status: 'success',
      durationMs: 0,
    });
    return decision;
  }

  const modelEntries = resolveModelEntries(capability, capConfig, globalConfig);

  for (const entry of modelEntries) {
    const start = Date.now();

    const maxBytes = entry.maxBytes ?? capConfig.maxBytes;
    if (maxBytes) {
      const size = getFileSize(path);
      if (size > maxBytes) {
        decision.attempts.push({
          provider:
            entry.type === 'cli' ? `cli:${entry.command}` : entry.provider,
          model: entry.type === 'cli' ? entry.command : entry.model,
          status: 'skipped',
          reason: `file size ${size} > maxBytes ${maxBytes}`,
          durationMs: 0,
        });
        continue;
      }
    }

    try {
      if (capability === 'audio') await acquireAudioSemaphore();

      const text = await callProvider(entry, path, capability, capConfig);

      if (capability === 'audio') releaseAudioSemaphore();

      const output: MediaUnderstandingOutput = {
        capability,
        text: truncate(text, entry.maxChars ?? capConfig.maxChars ?? 500),
        provider:
          entry.type === 'cli' ? `cli:${entry.command}` : entry.provider,
        model: entry.type === 'cli' ? entry.command : entry.model,
        cached: false,
        durationMs: Date.now() - start,
        attachmentPath: path,
      };

      await writeCache(cacheKey, output, globalConfig.cache);

      decision.finalResult = output;
      decision.attempts.push({
        provider: output.provider,
        model: output.model,
        status: 'success',
        durationMs: output.durationMs,
      });
      break;
    } catch (err) {
      if (capability === 'audio') releaseAudioSemaphore();

      decision.attempts.push({
        provider:
          entry.type === 'cli' ? `cli:${entry.command}` : entry.provider,
        model:
          entry.type === 'cli'
            ? entry.command
            : ((entry as { model?: string }).model ?? 'unknown'),
        status: 'failed',
        reason: String(err),
        durationMs: Date.now() - start,
      });
    }
  }

  return decision;
}

async function computeContentHash(path: string): Promise<string> {
  // 流式 hash，避免大文件全量加载到内存
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex').slice(0, 16);
}

function selectAttachments(
  ctx: MsgContext,
  capability: MediaCapability,
  capConfig?: CapabilityConfig,
): string[] {
  const mode = capConfig?.attachments?.mode ?? 'first';
  const max = capConfig?.attachments?.maxAttachments ?? 1;

  const matched = (ctx.MediaPaths ?? []).filter((path, i) => {
    const mimeType = ctx.MediaTypes?.[i] ?? inferMimeType(path);
    return mimeTypeMatchesCapability(mimeType, capability);
  });

  return mode === 'all' ? matched.slice(0, max) : matched.slice(0, 1);
}

function getFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

function mimeTypeMatchesCapability(
  mimeType: string,
  capability: MediaCapability,
): boolean {
  const imageTypes = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'image/bmp',
    'image/tiff',
  ];
  const audioTypes = [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/ogg',
    'audio/m4a',
    'audio/aac',
    'audio/flac',
  ];
  const videoTypes = [
    'video/mp4',
    'video/quicktime',
    'video/x-msvideo',
    'video/webm',
    'video/mpeg',
  ];

  switch (capability) {
    case 'image':
      return imageTypes.some((t) => mimeType.toLowerCase().includes(t));
    case 'audio':
      return audioTypes.some((t) => mimeType.toLowerCase().includes(t));
    case 'video':
      return videoTypes.some((t) => mimeType.toLowerCase().includes(t));
    default:
      return false;
  }
}

function inferMimeType(path: string): string {
  const ext = path.toLowerCase().substring(path.lastIndexOf('.'));
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/m4a',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}

async function callProvider(
  entry: {
    type: 'provider' | 'cli';
    provider?: string;
    model?: string;
    command?: string;
    args?: string[];
    capabilities?: MediaCapability[];
  },
  path: string,
  capability: MediaCapability,
  opts: CapabilityConfig,
): Promise<string> {
  if (entry.type === 'cli') {
    return runCliProvider(
      entry as Extract<typeof entry, { type: 'cli' }>,
      path,
      {
        maxChars: opts.maxChars,
        prompt: opts.prompt,
        timeoutMs: (opts.timeoutSeconds ?? 60) * 1000,
      },
    );
  }

  const provider = getProvider(entry.provider ?? '');
  if (!provider) {
    throw new Error(`Provider '${entry.provider}' not found`);
  }

  switch (capability) {
    case 'image':
      if (!provider.describeImage)
        throw new Error(
          `Provider '${provider.name}' does not support image description`,
        );
      return provider.describeImage(path, {
        maxChars: opts.maxChars,
        prompt: opts.prompt,
        timeoutMs: (opts.timeoutSeconds ?? 30) * 1000,
        model: entry.model,
      });

    case 'audio':
      if (!provider.transcribeAudio)
        throw new Error(
          `Provider '${provider.name}' does not support audio transcription`,
        );
      return provider.transcribeAudio(path, {
        maxChars: opts.maxChars,
        prompt: opts.prompt,
        timeoutMs: (opts.timeoutSeconds ?? 60) * 1000,
        language: opts.language,
        model: entry.model,
      });

    case 'video':
      if (!provider.describeVideo)
        throw new Error(
          `Provider '${provider.name}' does not support video description`,
        );
      return provider.describeVideo(path, {
        maxChars: opts.maxChars,
        prompt: opts.prompt,
        timeoutMs: (opts.timeoutSeconds ?? 60) * 1000,
        model: entry.model,
      });

    default:
      throw new Error(`Unsupported capability: ${capability}`);
  }
}
