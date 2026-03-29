import type {
  ModelEntry,
  MediaCapability,
  CapabilityConfig,
  MediaConfig,
} from './types.js';

export function resolveModelEntries(
  capability: MediaCapability,
  capConfig: CapabilityConfig,
  globalConfig: MediaConfig,
): ModelEntry[] {
  const entries: ModelEntry[] = [];

  if (capConfig.models?.length) {
    entries.push(...filterByCapability(capConfig.models, capability));
  }

  if (globalConfig.models?.length) {
    entries.push(...filterByCapability(globalConfig.models, capability));
  }

  if (!entries.length) {
    const autoEntry = resolveAutoModel(capability);
    if (autoEntry) entries.push(autoEntry);
  }

  return entries;
}

function filterByCapability(
  models: ModelEntry[],
  capability: MediaCapability,
): ModelEntry[] {
  return models.filter((m) => {
    if (!m.capabilities || m.capabilities.length === 0) {
      return inferCapabilities(m).includes(capability);
    }
    return m.capabilities.includes(capability);
  });
}

function inferCapabilities(entry: ModelEntry): MediaCapability[] {
  if (entry.type === 'cli') return entry.capabilities ?? [];

  const capMap: Record<string, MediaCapability[]> = {
    openai: ['image', 'audio'],
    anthropic: ['image'],
    google: ['image', 'audio', 'video'],
    deepgram: ['audio'],
    ark: ['image', 'audio'],
  };
  return capMap[entry.provider] ?? [];
}

function resolveAutoModel(capability: MediaCapability): ModelEntry | null {
  const activeProvider = process.env.MEDIA_PRIMARY_PROVIDER;
  const activeModel = process.env.MEDIA_PRIMARY_MODEL;

  if (!activeProvider || !activeModel) return null;

  const visionProviders = ['anthropic', 'openai', 'google', 'ark'];
  if (capability === 'image' && visionProviders.includes(activeProvider)) {
    return {
      type: 'provider',
      provider: activeProvider,
      model: activeModel,
      capabilities: ['image'],
    };
  }
  if (capability === 'audio' && ['openai', 'google'].includes(activeProvider)) {
    return {
      type: 'provider',
      provider: activeProvider,
      model: activeModel,
      capabilities: ['audio'],
    };
  }
  return null;
}
