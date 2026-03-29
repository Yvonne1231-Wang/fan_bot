import type { MediaConfig } from './types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('media:config');

export function loadMediaConfigFromEnv(): MediaConfig {
  const config: MediaConfig = {};

  const imageProvider = process.env.MEDIA_IMAGE_PROVIDER;
  const imageModel = process.env.MEDIA_IMAGE_MODEL;
  if (imageProvider && imageModel) {
    config.models = config.models ?? [];
    config.models.push({
      type: 'provider',
      provider: imageProvider,
      model: imageModel,
      capabilities: ['image'],
    });
  }

  const audioProvider = process.env.MEDIA_AUDIO_PROVIDER;
  const audioModel = process.env.MEDIA_AUDIO_MODEL;
  if (audioProvider && audioModel) {
    config.models = config.models ?? [];
    config.models.push({
      type: 'provider',
      provider: audioProvider,
      model: audioModel,
      capabilities: ['audio'],
    });
  }

  if (process.env.MEDIA_CACHE_ENABLED === 'false') {
    config.cache = { enabled: false };
  } else {
    const ttlDays = process.env.MEDIA_CACHE_TTL_DAYS;
    const maxEntries = process.env.MEDIA_CACHE_MAX_ENTRIES;
    if (ttlDays || maxEntries) {
      config.cache = {
        enabled: true,
        ...(ttlDays ? { ttlDays: Number(ttlDays) } : {}),
        ...(maxEntries ? { maxEntries: Number(maxEntries) } : {}),
      };
    }
  }

  const imageScope = process.env.MEDIA_IMAGE_SCOPE;
  if (imageScope) {
    config.scope = {
      image: imageScope as 'all' | 'dm' | 'paired' | 'main' | 'disabled',
    };
    log.debug('loaded scope:', config.scope);
  }

  const imageMaxChars = process.env.MEDIA_IMAGE_MAX_CHARS;
  if (imageMaxChars) {
    config.image = { ...config.image, maxChars: Number(imageMaxChars) };
  }

  const audioMaxChars = process.env.MEDIA_AUDIO_MAX_CHARS;
  if (audioMaxChars) {
    config.audio = { ...config.audio, maxChars: Number(audioMaxChars) };
  }

  return config;
}
