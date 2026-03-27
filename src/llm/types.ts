// ─── LLM Adapter Types ───────────────────────────────────────────────

// Content block types (mirrors Anthropic's format as the internal standard)
export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock;

// Message type (internal format mirrors Anthropic)
export interface Message {
  role: 'user' | 'assistant';
  content: Array<ContentBlock>;
}

// Tool schema for LLM
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// LLM Response
export interface LLMResponse {
  content: Array<ContentBlock>;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Agent callbacks for streaming card rendering
export interface AgentCallbacks {
  onThinking?: (text: string) => void;
  onThinkingStop?: () => void;
  onToolStart?: (
    toolName: string,
    input: Record<string, unknown> | undefined,
    parentToolUseId?: string | null,
    toolUseId?: string,
  ) => void;
  onToolEnd?: (
    toolName: string,
    output: string,
    parentToolUseId?: string | null,
  ) => void;
  onContentDelta?: (delta: string) => void;
  onComplete?: () => void;
  onError?: (error: string) => void;
}

// LLM Client interface
export interface LLMClient {
  chat(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<LLMResponse>;

  stream?(
    messages: Message[],
    tools: ToolSchema[],
    systemPrompt: string | undefined,
    onChunk: (text: string) => void,
    onThinking?: (thinking: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse>;
}
