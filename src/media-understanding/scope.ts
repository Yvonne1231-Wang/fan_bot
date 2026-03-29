import type { MsgContext, MediaCapability, MediaConfig } from './types.js';

type ScopeValue = 'all' | 'dm' | 'paired' | 'main' | 'disabled';

export function passesScope(
  ctx: MsgContext,
  capability: MediaCapability,
  scope?: MediaConfig['scope']
): boolean {
  const rule: ScopeValue = scope?.[capability] ?? 'all';

  switch (rule) {
    case 'disabled':
      return false;

    case 'all':
      return true;

    case 'dm':
      return ctx.ChatType === 'direct';

    case 'paired':
      return ctx.IsPaired === true || ctx.IsMainSession === true;

    case 'main':
      return ctx.IsMainSession === true;

    default:
      return true;
  }
}
