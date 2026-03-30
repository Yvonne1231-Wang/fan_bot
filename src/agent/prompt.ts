import { readFile, copyFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { MemoryService } from '../memory/types.js';
import type { SkillEntry } from '../skills/types.js';
import { formatSkillsForPrompt } from '../skills/loader.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('agent:prompt');

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

let _cachedIdentity: Identity | null = null;
let _cachedIdentityLoaded = false;
let _cachedSoul: Soul | null | undefined = undefined;
let _cachedSoulLoaded = false;

async function ensureFile(filename: string): Promise<string> {
  const filePath = join(process.cwd(), filename);
  const examplePath = join(process.cwd(), `${filename}.example`);

  if (!existsSync(filePath) && existsSync(examplePath)) {
    await copyFile(examplePath, filePath);
  }

  return filePath;
}

async function loadIdentity(): Promise<Identity> {
  if (_cachedIdentityLoaded) {
    return _cachedIdentity ?? { name: 'Assistant', emoji: '🤖' };
  }

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

    _cachedIdentity = identity;
    _cachedIdentityLoaded = true;
    return identity;
  } catch {
    _cachedIdentity = { name: 'Assistant', emoji: '🤖' };
    _cachedIdentityLoaded = true;
    return _cachedIdentity;
  }
}

async function loadSoul(): Promise<Soul | null> {
  if (_cachedSoulLoaded) {
    return _cachedSoul ?? null;
  }

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

    _cachedSoul = soul.coreTruths.length > 0 ? soul : null;
    _cachedSoulLoaded = true;
    return _cachedSoul;
  } catch {
    _cachedSoul = null;
    _cachedSoulLoaded = true;
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
    skills?: SkillEntry[];
  } = {},
): Promise<string> {
  const { extraContext, memory, userQuery, skills } = options;

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
    try {
      const ctx = await memory.buildContext(userQuery);
      if (ctx) memoryContext = `\n\n${ctx}`;
    } catch (err) {
      log.warn(`Memory context build failed: ${err}`);
      memoryContext = '\n\n[Memory: temporarily unavailable]';
    }
  }

  let skillsContext = '';
  if (skills && skills.length > 0) {
    skillsContext = `\n\n## Available Skills\n\n${formatSkillsForPrompt(skills)}\n\n**How to use skills:**\n1. Before using tools related to a skill, call the \`Skill\` tool with the skill name to declare your intent\n2. Example: \`Skill(skill_name="feishu-create-doc", action="create")\`\n3. This helps track skill usage and provides better visibility to the user\n4. Then proceed with the actual tool calls for that skill\n\nRefer to each skill's SKILL.md file for detailed guidance on tool usage patterns, constraints, and best practices.`;
  }

  const extra = extraContext ? `\n\n${extraContext}` : '';
  const now = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
  });
  return (
    base +
    memoryContext +
    skillsContext +
    `\n\n## Current Time\n\n${now}` +
    extra
  );
}

export { loadIdentity, loadSoul, type Identity, type Soul };
