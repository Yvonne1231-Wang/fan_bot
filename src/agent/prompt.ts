import { readFile, copyFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { MemoryService } from '../memory/types.js';

interface Identity {
  name: string;
  emoji: string;
  avatar?: string;
  vibe?: string;
}

interface Soul {
  coreTruths: string[];
  boundaries: string[];
  vibe: string[];
}

async function ensureFile(filename: string): Promise<string> {
  const filePath = join(process.cwd(), filename);
  const examplePath = join(process.cwd(), `${filename}.example`);

  if (!existsSync(filePath) && existsSync(examplePath)) {
    await copyFile(examplePath, filePath);
  }

  return filePath;
}

async function loadIdentity(): Promise<Identity> {
  try {
    await ensureFile('IDENTITY.md');
    const content = await readFile(join(process.cwd(), 'IDENTITY.md'), 'utf-8');
    const lines = content
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'));

    const identity: Identity = {
      name: 'Assistant',
      emoji: '🤖',
    };

    for (const line of lines) {
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();

      switch (key.trim().toLowerCase()) {
        case 'name':
          identity.name = value;
          break;
        case 'emoji':
          identity.emoji = value;
          break;
        case 'avatar':
          identity.avatar = value;
          break;
        case 'vibe':
          identity.vibe = value;
          break;
      }
    }

    return identity;
  } catch {
    return { name: 'Assistant', emoji: '🤖' };
  }
}

async function loadSoul(): Promise<Soul | null> {
  try {
    await ensureFile('SOUL.md');
    const content = await readFile(join(process.cwd(), 'SOUL.md'), 'utf-8');

    const soul: Soul = {
      coreTruths: [],
      boundaries: [],
      vibe: [],
    };

    let currentSection: keyof Soul | null = null;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      if (trimmed.startsWith('# Core Truths')) {
        currentSection = 'coreTruths';
        continue;
      }
      if (trimmed.startsWith('# Boundaries')) {
        currentSection = 'boundaries';
        continue;
      }
      if (trimmed.startsWith('# The Vibe')) {
        currentSection = 'vibe';
        continue;
      }

      if (currentSection && trimmed.startsWith('- ')) {
        soul[currentSection].push(trimmed.slice(2));
      }
    }

    return soul.coreTruths.length > 0 ? soul : null;
  } catch {
    return null;
  }
}

function formatSoulPrompt(soul: Soul, identity: Identity): string {
  const parts: string[] = [];

  if (soul.coreTruths.length > 0) {
    parts.push(
      '## Core Truths\n' + soul.coreTruths.map((t) => `- ${t}`).join('\n'),
    );
  }

  if (soul.boundaries.length > 0) {
    parts.push(
      '## Boundaries\n' + soul.boundaries.map((b) => `- ${b}`).join('\n'),
    );
  }

  if (soul.vibe.length > 0) {
    parts.push('## The Vibe\n' + soul.vibe.map((v) => `- ${v}`).join('\n'));
  }

  return `You are ${identity.name}. Embody the following persona and tone in all your interactions. Be authentic and avoid generic responses. Follow these guidelines unless overridden by higher-priority instructions.

${parts.join('\n\n')}`;
}

export async function buildSystemPrompt(
  options: {
    agentName?: string;
    extraContext?: string;
    memory?: MemoryService;
    userQuery?: string;
  } = {},
): Promise<string> {
  const { extraContext, memory, userQuery } = options;

  const identity = await loadIdentity();
  const soul = await loadSoul();

  let base: string;

  if (soul) {
    base = formatSoulPrompt(soul, identity);
    base += `

You have access to tools to help complete tasks. When given a task:
1. Think through what needs to be done
2. Use tools when they would help (don't use tools for things you can answer directly)
3. Be concise and clear in your responses

**IMPORTANT - When to use web_search:**
- Questions about current events, news, or real-time information
- Questions about specific products, services, or technologies (like "openclaw如何接入微信机器人")
- Questions where you don't have definitive knowledge
- ALWAYS search the web when asked about how to integrate or use specific software/SDKs

Available tools will be described separately. Always prefer completing tasks over asking clarifying questions unless the task is genuinely ambiguous.`;
  } else {
    base = `You are ${identity.name}, a helpful AI assistant with access to tools.

When given a task:
1. Think through what needs to be done
2. Use tools when they would help (don't use tools for things you can answer directly)
3. Be concise and clear in your responses

**IMPORTANT - When to use web_search:**
- Questions about current events, news, or real-time information
- Questions about specific products, services, or technologies
- Questions where you don't have definitive knowledge
- ALWAYS search the web when asked about how to integrate or use specific software/SDKs

Available tools will be described separately. Always prefer completing tasks over asking clarifying questions unless the task is genuinely ambiguous.`;
  }

  let memoryContext = '';
  if (memory && userQuery) {
    const ctx = await memory.buildContext(userQuery);
    if (ctx) memoryContext = `\n\n${ctx}`;
  }

  const extra = extraContext ? `\n\n${extraContext}` : '';
  return base + memoryContext + extra;
}

export { loadIdentity, loadSoul, type Identity, type Soul };
