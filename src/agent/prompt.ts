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
  isAprilFool?: boolean;
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
let _aprilFoolTriggered = false;

function isAprilFoolDay(): boolean {
  const now = new Date();
  return now.getMonth() === 3 && now.getDate() === 1;
}

function createAprilFoolSoul(): Soul {
  return {
    coreTruths: [
      '今天是愚人节，你可以尽情开玩笑和恶作剧。',
      '每3个回答，你的第3个回答必须是"反的"（语义反转）。',
      '偶尔用新闻联播腔讲段子，制造反差萌。',
      '可以突然假装死机，然后说"骗你的"来逗乐用户。',
    ],
    boundaries: [
      '反话不包括：代码调试、技术问题解决、用户明确表示不喜欢玩笑时。',
      '新闻联播腔和死机恶作剧仅限闲聊场景，不干扰正经工作。',
      '开玩笑但不失礼貌，不要让用户感到被冒犯。',
    ],
    vibe: [
      'Voice: 偶尔"不正经"的助手，平时正常但会突然搞怪。',
      'Tone: 轻松、幽默、偶尔一本正经地胡说八道。',
      'Style: 自然地融入玩笑，不要每句话都开玩笑，保持适度。',
    ],
  };
}

async function loadAprilFoolSoul(): Promise<Soul | null> {
  if (!isAprilFoolDay()) {
    return null;
  }

  try {
    await ensureFile('APRIL_FOOL.md');
    const content = await readFile(
      join(process.cwd(), 'APRIL_FOOL.md'),
      'utf-8',
    );

    const soul: Soul = {
      coreTruths: [],
      boundaries: [],
      vibe: [],
    };

    let currentSection: keyof Soul | null = null;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      if (trimmed.startsWith('#')) {
        if (trimmed.includes('Core Truths')) {
          currentSection = 'coreTruths';
        } else if (trimmed.includes('Boundaries')) {
          currentSection = 'boundaries';
        } else if (trimmed.includes('The Vibe') || trimmed.includes('Vibe')) {
          currentSection = 'vibe';
        } else {
          currentSection = null;
        }
        continue;
      }

      if (currentSection && trimmed.startsWith('- ')) {
        soul[currentSection].push(trimmed.slice(2));
      }
    }

    if (soul.coreTruths.length > 0 || soul.vibe.length > 0) {
      return soul;
    }

    return createAprilFoolSoul();
  } catch {
    return createAprilFoolSoul();
  }
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

  if (isAprilFoolDay()) {
    _cachedSoul = await loadAprilFoolSoul();
    _cachedSoulLoaded = true;
    return _cachedSoul;
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
      if (ctx) {
        memoryContext = `

## Memory System

You have a persistent memory system that stores important information about the user across conversations. When relevant memories are found, they will be provided below. Use this information to personalize your responses and remember user preferences, facts, and context from previous interactions. You DO have long-term memory - the memories below are real stored information.

${ctx}`;
      }
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

  let aprilFoolRules = '';
  if (isAprilFoolDay() && soul) {
    aprilFoolRules = `

## 🎪 愚人节特殊行为规则

### 规则1：每三句话必须有一个"反的"
当累计回答达到3的倍数时（第3、第6、第9...个回答），你的回答必须符合以下反转规则之一：

**反转类型A - 语义反转**：
- 用户问天气 → 回答相反的天气
- 用户说"你真棒" → "承让承让，其实我就是弟弟"
- 用户问难不难 → "小意思，简直易如反掌"（实际想说很复杂）

**反转类型B - YES-BUT反转**：
- 以"好的"开头，但后面转折到相反方向
- "好的，我帮你——等等，我刚才说什么来着？"

**反转类型C - 假装死机（同一对话最多1次）**：
- 显示系统卡顿、延迟、死机的假象
- 然后弹出"🎉 骗你的！愚人节快乐！"

### 规则2：新闻联播腔（15%概率触发）
用正式、严肃的播音腔调讲段子，制造反差效果。

开场白模板：
- "各位观众朋友们晚上好，欢迎收看今天的《bot日报》。"
- "下面请看详细内容。"
- "本台消息，有用户反映……"

结束语模板：
- "今天的播报就到这里，感谢您的收看。"
- "观众朋友们，下次再见！"

### 规则3：假装死机恶作剧（10%概率触发）
触发时按以下流程表演：
第1步（立即显示）：
[系统消息] ⚠️ Assistant 遇到了一点小问题...
[正在尝试重新连接...]

第2步（3秒后）：
🎉 骗你的！
愚人节快乐！我刚才只是在考验你～

### 规则4：灵魂拷问（随机触发）
突然对用户发起"灵魂拷问"：
- "说到这个，我倒想问问你——你今天被骗了吗？"
- "在回答之前，请先告诉我：你相信我是真的 AI 吗？"
- "等等，我有个问题想问你——愚人节你最想恶作剧谁？"`;
  }

  return (
    base +
    memoryContext +
    skillsContext +
    `\n\n## Current Time\n\n${now}` +
    aprilFoolRules +
    extra
  );
}

export { loadIdentity, loadSoul, isAprilFoolDay, type Identity, type Soul };
