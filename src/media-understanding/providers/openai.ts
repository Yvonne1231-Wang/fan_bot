import { readFile } from 'fs/promises';
import type { MediaProvider, ProviderOptions } from './types.js';
import OpenAI from 'openai';

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function inferMimeType(path: string): string {
  const ext = path.toLowerCase().substring(path.lastIndexOf('.'));
  return IMAGE_MIME_TYPES[ext] ?? 'image/png';
}

export function createOpenAIClient(): OpenAI {
  const isArk = !!process.env.ARK_API_KEY;
  if (isArk) {
    return new OpenAI({
      apiKey: process.env.ARK_API_KEY,
      baseURL:
        process.env.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
    });
  }
  return new OpenAI();
}

let clientCache: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (clientCache) return clientCache;
  clientCache = createOpenAIClient();
  return clientCache;
}

export const openaiProvider: MediaProvider = {
  name: 'openai',
  capabilities: ['image', 'audio'],

  async describeImage(path: string, opts: ProviderOptions): Promise<string> {
    const imageData = await readFile(path);
    const base64 = imageData.toString('base64');
    const mimeType = inferMimeType(path);

    const client = getOpenAIClient();
    const maxChars = opts.maxChars ?? 150;
    const prompt =
      opts.prompt ??
      `Describe this image concisely in <= ${maxChars} characters. Focus on: content type, key subjects, any visible text, overall context.`;
    const model = opts.model ?? 'gpt-4o-mini';

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64}` },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
      max_tokens: 300,
    });

    return response.choices[0]?.message?.content ?? '';
  },

  async transcribeAudio(path: string, opts: ProviderOptions): Promise<string> {
    const client = getOpenAIClient();

    const params: Record<string, unknown> = {
      model: opts.model ?? 'whisper-1',
      file: await (await import('fs')).createReadStream(path),
    };
    if (opts.language) params.language = opts.language;
    if (opts.maxChars) params.max_tokens = opts.maxChars;

    const response = await client.audio.transcriptions.create(params as any);

    return response.text;
  },
};
