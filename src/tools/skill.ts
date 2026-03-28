// ─── Skill Tool ──────────────────────────────────────────────────────────────

import type { Tool } from './types.js';
import { getGlobalLoader } from '../skills/loader.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('tools:skill');

export const skillTool: Tool = {
  schema: {
    name: 'Skill',
    description: `Declare intent to use a specific skill. Call this tool BEFORE using skill-related tools to indicate which skill you are applying.

This helps track skill usage and provides context for the user.

Example:
- Before using feishu document tools, call Skill(skill_name="feishu-create-doc")
- Before using feishu bitable tools, call Skill(skill_name="feishu-bitable")`,
    input_schema: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'The name of the skill to use (e.g., "feishu-create-doc", "feishu-bitable")',
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

    log.info(`Skill declared: ${skillName}${action ? ` (${action})` : ''}`);

    const parts: string[] = [
      `✓ Skill activated: ${skillName}`,
      `Description: ${skill.metadata.description}`,
    ];

    if (action) {
      parts.push(`Action: ${action}`);
    }

    if (context) {
      parts.push(`Context: ${context}`);
    }

    parts.push(`\nSkill location: ${skill.baseDir}`);
    parts.push('\nYou can now proceed with using the relevant tools for this skill.');

    return parts.join('\n');
  },
};
