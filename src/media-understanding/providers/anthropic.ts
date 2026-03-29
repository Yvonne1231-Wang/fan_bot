import { readFile } from 'fs/promises';
import type { MediaProvider, ProviderOptions } from './types.js';

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function inferMimeType(path: string): string {
  const ext = path.toLowerCase().substring(path.lastIndexOf('.'));
  return IMAGE_MIME_TYPES[ext] ?? 'image/png';
}

export const anthropicProvider: MediaProvider = {
  name: 'anthropic',
  capabilities: ['image'],

  async describeImage(path: string, opts: ProviderOptions): Promise<string> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const imageData = await readFile(path);
    const base64 = imageData.toString('base64');
    const mimeType = inferMimeType(path) as
      | 'image/png'
      | 'image/jpeg'
      | 'image/webp'
      | 'image/gif';

    const client = new Anthropic();
    const maxChars = opts.maxChars ?? 150;
    const prompt =
      opts.prompt ??
      `Describe this image concisely in <= ${maxChars} characters. Focus on: content type, key subjects, any visible text, overall context.`;
    const model = opts.model ?? 'claude-haiku-4-5';

    const response = await client.messages.create({
      model,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64 },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return text;
  },
};
