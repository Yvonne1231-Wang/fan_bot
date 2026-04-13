// ─── Skill Tool ──────────────────────────────────────────────────────────────

import type { Tool } from './types.js';
import { getGlobalLoader } from '../skills/loader.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('tools:skill');

const MAX_SKILL_CONTENT_CHARS = 8000;

export const skillTool: Tool = {
  schema: {
    name: 'Skill',
    description: `Activate a skill and receive its full SKILL.md guide (commands, parameters, examples). You MUST call this tool BEFORE using any lark-cli commands or skill-specific tools — do NOT guess command names.

Example:
- Before using feishu IM tools, call Skill(skill_name="lark-im")
- Before extracting menus, call Skill(skill_name="group-menu-extractor")`,
    input_schema: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'The name of the skill to use (e.g., "lark-im", "group-menu-extractor")',
        },
        action: {
          type: 'string',
          description: 'Optional: The specific action you plan to perform (e.g., "create", "query", "update")',
        },
        context: {
          type: 'string',
          description: 'Optional: Additional context about what you are trying to achieve',
        },
      },
      required: ['skill_name'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const skillName = String(input.skill_name || '');
    const action = input.action ? String(input.action) : '';
    const context = input.context ? String(input.context) : '';

    if (!skillName) {
      return 'Error: skill_name is required';
    }

    const loader = getGlobalLoader();
    const skills = loader.getAllSkills();
    const skill = skills.find((s) => s.metadata.name === skillName);

    if (!skill) {
      const availableSkills = skills.map((s) => s.metadata.name).join(', ');
      return `Error: Skill "${skillName}" not found. Available skills: ${availableSkills}`;
    }

    log.info(`Skill activated: ${skillName}${action ? ` (${action})` : ''}`);

    const parts: string[] = [
      `✓ Skill activated: ${skillName}`,
    ];

    if (action) {
      parts.push(`Action: ${action}`);
    }

    if (context) {
      parts.push(`Context: ${context}`);
    }

    let skillContent = skill.content;
    if (skillContent.length > MAX_SKILL_CONTENT_CHARS) {
      skillContent = skillContent.slice(0, MAX_SKILL_CONTENT_CHARS) + '\n\n[... truncated, full content at: ' + skill.baseDir + '/SKILL.md]';
    }

    parts.push(`\n--- SKILL.md ---\n${skillContent}`);

    return parts.join('\n');
  },
};
