export type MediaCapability = 'image' | 'audio' | 'video';

export interface MediaUnderstandingOutput {
  capability: MediaCapability;
  text: string;
  provider: string;
  model: string;
  cached: boolean;
  durationMs: number;
}

export interface AttachmentDecision {
  attachmentPath: string;
  capability: MediaCapability;
  attempts: Array<{
    provider: string;
    model: string;
    status: 'success' | 'failed' | 'skipped';
    reason?: string;
    durationMs: number;
  }>;
  finalResult: MediaUnderstandingOutput | null;
}

export interface MediaUnderstandingResult {
  outputs: MediaUnderstandingOutput[];
  decisions: AttachmentDecision[];
}

export interface ProviderOptions {
  prompt?: string;
  maxChars?: number;
  maxBytes?: number;
  timeoutMs?: number;
  language?: string;
  model?: string;
}

export interface MediaProvider {
  name: string;
  capabilities: MediaCapability[];
  describeImage?(path: string, opts: ProviderOptions): Promise<string>;
  transcribeAudio?(path: string, opts: ProviderOptions): Promise<string>;
  describeVideo?(path: string, opts: ProviderOptions): Promise<string>;
}

export type ModelEntry =
  | {
      type: 'provider';
      provider: string;
      model: string;
      capabilities?: MediaCapability[];
      maxChars?: number;
      maxBytes?: number;
      timeoutSeconds?: number;
      prompt?: string;
    }
  | {
      type: 'cli';
      command: string;
      args: string[];
      capabilities: MediaCapability[];
      maxChars?: number;
      maxBytes?: number;
      timeoutSeconds?: number;
    };

export interface CapabilityConfig {
  enabled?: boolean;
  models?: ModelEntry[];
  maxChars?: number;
  maxBytes?: number;
  timeoutSeconds?: number;
  prompt?: string;
  language?: string;
  echoTranscript?: boolean;
  echoFormat?: string;
  attachments?: {
    mode: 'first' | 'all';
    maxAttachments?: number;
  };
}

export interface MediaConfig {
  models?: ModelEntry[];
  image?: CapabilityConfig;
  audio?: CapabilityConfig;
  video?: CapabilityConfig;
  scope?: {
    image?: 'all' | 'dm' | 'paired' | 'main' | 'disabled';
    audio?: 'all' | 'dm' | 'paired' | 'main' | 'disabled';
    video?: 'all' | 'dm' | 'paired' | 'main' | 'disabled';
  };
  cache?: {
    enabled?: boolean;
    ttlDays?: number;
    maxEntries?: number;
    storagePath?: string;
  };
}

export interface MsgContext {
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  mediaUnderstanding?: MediaUnderstandingResult;
  ChatType?: 'direct' | 'group';
  SessionKey?: string;
  IsPaired?: boolean;
  IsMainSession?: boolean;
  Body?: string;
}
