// ─── Describe Image Tool ────────────────────────────────────────────────────

import type { Tool } from '../tools/types.js';
import { createOpenAIClient, inferMimeType } from './providers/openai.js';
import { readFile } from 'fs/promises';

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

export const describeImageTool: Tool = {
  schema: {
    name: 'describe_image',
    description:
      'Analyze an image file and return a detailed text description. Use this when you need to understand the content of an image that was shared in the conversation. Input is the file path of the image.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file path of the image to analyze',
        },
        maxChars: {
          type: 'number',
          description: 'Maximum characters for the description (default: 500)',
        },
        prompt: {
          type: 'string',
          description:
            'Custom prompt for the vision model. Use this to ask specific questions about the image instead of getting a generic description.',
        },
      },
      required: ['path'],
    },
  },

  parallelSafe: true,

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const path = String(input.path);
    const maxChars = Number(input.maxChars) || 500;
    const customPrompt = input.prompt ? String(input.prompt) : '';

    try {
      const imageData = await readFile(path);
      const base64 = imageData.toString('base64');
      const mimeType = inferMimeType(path);

      const client = createOpenAIClient();
      const model = process.env.MEDIA_IMAGE_MODEL ?? 'ep-20260122194637-nbwvr';

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
              {
                type: 'text',
                text: customPrompt
                  || `Describe this image concisely in <= ${maxChars} characters. Focus on: content type, key subjects, any visible text, overall context.`,
              },
            ],
          },
        ],
        max_tokens: 300,
      });

      const text = response.choices[0]?.message?.content ?? '';
      return truncate(text, maxChars);
    } catch (err) {
      throw new Error(`Failed to describe image: ${err}`);
    }
  },
};
