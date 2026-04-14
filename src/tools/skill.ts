// ─── Skill Tool ──────────────────────────────────────────────────────────────

import type { Tool } from './types.js';
import { getGlobalLoader } from '../skills/loader.js';
import {
  listPendingSkills,
  confirmPendingSkill,
  rejectPendingSkill,
} from '../skills/extractor.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('tools:skill');

const MAX_SKILL_CONTENT_CHARS = 8000;

export const skillTool: Tool = {
  schema: {
    name: 'Skill',
    description: `Manage and activate skills.

Actions:
- **activate** (default): Load a skill's SKILL.md guide. Call BEFORE using any skill-specific tools.
- **list_pending**: List auto-extracted skills waiting for user confirmation.
- **confirm**: Install a pending skill. Requires skill_name.
- **reject**: Discard a pending skill. Requires skill_name.

Examples:
- Skill(skill_name="lark-im") → activate skill
- Skill(action="list_pending") → show pending skills
- Skill(action="confirm", skill_name="deploy-workflow") → install pending skill
- Skill(action="reject", skill_name="deploy-workflow") → discard pending skill`,
    input_schema: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'The skill name (required for activate/confirm/reject)',
        },
        action: {
          type: 'string',
          enum: ['activate', 'list_pending', 'confirm', 'reject'],
          description: 'Action to perform. Default: "activate"',
        },
        context: {
          type: 'string',
          description: 'Optional: Additional context about what you are trying to achieve',
        },
      },
      required: [],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const action = String(input.action || 'activate');
    const skillName = String(input.skill_name || '');

    // ─── list_pending ──────────────────────────────────────────────────
    if (action === 'list_pending') {
      try {
        const pending = await listPendingSkills();
        if (pending.length === 0) {
          return 'No pending skills awaiting confirmation.';
        }
        const lines = pending.map(
          (p) =>
            `- **${p.candidate.name}** (confidence: ${p.candidate.confidence.toFixed(2)})\n  ${p.candidate.description}\n  Reason: ${p.candidate.reason}`,
        );
        return `Pending skills (${pending.length}):\n\n${lines.join('\n\n')}`;
      } catch (error) {
        return `Error listing pending skills: ${error}`;
      }
    }

    // ─── confirm ───────────────────────────────────────────────────────
    if (action === 'confirm') {
      if (!skillName) return 'Error: skill_name is required for confirm action';
      try {
        const ok = await confirmPendingSkill(skillName);
        if (ok) {
          // Reload skills so the newly installed skill is available immediately
          await getGlobalLoader().loadAll();
          return `✓ Skill "${skillName}" confirmed and installed. It is now active.`;
        }
        return `Error: Pending skill "${skillName}" not found. Use action="list_pending" to see available pending skills.`;
      } catch (error) {
        return `Error confirming skill: ${error}`;
      }
    }

    // ─── reject ────────────────────────────────────────────────────────
    if (action === 'reject') {
      if (!skillName) return 'Error: skill_name is required for reject action';
      try {
        const ok = await rejectPendingSkill(skillName);
        if (ok) {
          return `✓ Pending skill "${skillName}" rejected and removed.`;
        }
        return `Error: Pending skill "${skillName}" not found.`;
      } catch (error) {
        return `Error rejecting skill: ${error}`;
      }
    }

    // ─── activate (default) ────────────────────────────────────────────
    if (!skillName) {
      return 'Error: skill_name is required. Use action="list_pending" to see pending skills.';
    }

    const loader = getGlobalLoader();
    const skills = loader.getAllSkills();
    const skill = skills.find((s) => s.metadata.name === skillName);

    if (!skill) {
      const availableSkills = skills.map((s) => s.metadata.name).join(', ');
      return `Error: Skill "${skillName}" not found. Available skills: ${availableSkills}`;
    }

    log.info(`Skill activated: ${skillName}`);

    const parts: string[] = [`✓ Skill activated: ${skillName}`];

    if (input.context) {
      parts.push(`Context: ${String(input.context)}`);
    }

    let skillContent = skill.content;
    if (skillContent.length > MAX_SKILL_CONTENT_CHARS) {
      skillContent =
        skillContent.slice(0, MAX_SKILL_CONTENT_CHARS) +
        '\n\n[... truncated, full content at: ' +
        skill.baseDir +
        '/SKILL.md]';
    }

    parts.push(`\n--- SKILL.md ---\n${skillContent}`);

    return parts.join('\n');
  },
};
