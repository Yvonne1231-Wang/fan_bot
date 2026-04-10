// ─── LLM Client Factory ─────────────────────────────────────────────────────

import type { LLMClient } from './types.js';
import { createAnthropicClient } from './anthropic.js';
import { createOpenAIClient } from './openai.js';

// ─── Provider Constants ─────────────────────────────────────────────────────

/**
 * Available LLM providers.
 */
export const Provider = {
  Anthropic: 'anthropic' as const,
  Ark: 'ark' as const,
} as const;

/**
 * Type for LLM provider values.
 */
export type ProviderType = (typeof Provider)[keyof typeof Provider];

// ─── Factory Function ───────────────────────────────────────────────────────

/**
 * Options for creating an LLM client.
 */
export interface CreateLLMClientOptions {
  /**
   * The provider to use.
   */
  provider: ProviderType;

  /**
   * API key for the provider.
   * For Anthropic: ANTHROPIC_API_KEY
   * For Ark: ARK_API_KEY
   */
  apiKey: string;

  /**
   * Optional base URL for the API.
   * Required for Ark provider (ARK_BASE_URL).
   */
  baseURL?: string;

  /**
   * Optional model identifier.
   * Falls back to provider defaults if not specified.
   */
  model?: string;
}

/**
 * Create an LLM client for the specified provider.
 *
 * @param options - Configuration options
 * @returns An LLMClient implementation
 * @throws Error if the provider is not supported
 *
 * @example
 * ```typescript
 * // Anthropic client
 * const anthropicClient = createLLMClient({
 *   provider: Provider.Anthropic,
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 *   model: 'claude-sonnet-4-6',
 * });
 *
 * // Ark client (OpenAI-compatible)
 * const arkClient = createLLMClient({
 *   provider: Provider.Ark,
 *   apiKey: process.env.ARK_API_KEY!,
 *   baseURL: process.env.ARK_BASE_URL!,
 *   model: 'ep-xxx',
 * });
 * ```
 */
export function createLLMClient(options: CreateLLMClientOptions): LLMClient {
  switch (options.provider) {
    case Provider.Anthropic:
      return createAnthropicClient({
        apiKey: options.apiKey,
        model: options.model,
        baseURL: options.baseURL,
      });

    case Provider.Ark:
      return createOpenAIClient({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        model: options.model,
      });

    default:
      throw new Error(
        `Unsupported provider: ${(options as { provider: string }).provider}`,
      );
  }
}

/**
 * Create an LLM client from environment variables.
 *
 * Reads configuration from:
 * - LLM_PROVIDER: 'anthropic' (default) or 'ark'
 * - ANTHROPIC_API_KEY, ANTHROPIC_MODEL: For Anthropic provider
 * - ARK_API_KEY, ARK_BASE_URL, ARK_MODEL: For Ark provider
 *
 * @param providerOverride - Optional provider override
 * @returns An LLMClient implementation
 */
export function createLLMClientFromEnv(providerOverride?: string): LLMClient {
  const provider = providerOverride || process.env.LLM_PROVIDER || 'anthropic';

  if (provider === 'ark') {
    const apiKey = process.env.ARK_API_KEY;
    if (!apiKey) {
      throw new Error('ARK_API_KEY environment variable is required');
    }

    return createLLMClient({
      provider: Provider.Ark,
      apiKey,
      baseURL: process.env.ARK_BASE_URL,
      model: process.env.ARK_MODEL,
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  return createLLMClient({
    provider: Provider.Anthropic,
    apiKey,
    model: process.env.ANTHROPIC_MODEL,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export type {
  LLMClient,
  Message,
  ContentBlock,
  ToolSchema,
  LLMResponse,
} from './types.js';

// ─── Smoke Test ─────────────────────────────────────────────────────────────

async function runSmokeTest(): Promise<void> {
  console.log('Running LLM client smoke test...\n');

  // Check which provider to test based on env vars
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const arkKey = process.env.ARK_API_KEY;
  const arkBaseUrl = process.env.ARK_BASE_URL;
  const arkModel = process.env.ARK_MODEL;

  if (!anthropicKey && !arkKey) {
    console.log(
      'No API keys found. Set ANTHROPIC_API_KEY or ARK_API_KEY to run smoke test.',
    );
    console.log('Skipping smoke test.');
    return;
  }

  // Test Anthropic if key available
  if (anthropicKey) {
    console.log('Testing Anthropic provider...');
    try {
      const client = createLLMClient({
        provider: Provider.Anthropic,
        apiKey: anthropicKey,
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      });

      const response = await client.chat(
        [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Say "Hello from Anthropic" in 5 words or less.',
              },
            ],
          },
        ],
        [],
      );

      const textContent = response.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');

      console.log(`  Response: ${textContent}`);
      console.log(`  Stop reason: ${response.stop_reason}`);
      if (response.usage) {
        console.log(
          `  Tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`,
        );
      }
      console.log('  Anthropic test: ✅\n');
    } catch (error) {
      console.error(
        `  Anthropic test failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.log('  Anthropic test: ❌\n');
    }
  }

  // Test Ark if credentials available
  if (arkKey && arkBaseUrl && arkModel) {
    console.log('Testing Ark (OpenAI-compatible) provider...');
    try {
      const client = createLLMClient({
        provider: Provider.Ark,
        apiKey: arkKey,
        baseURL: arkBaseUrl,
        model: arkModel,
      });

      const response = await client.chat(
        [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Say "Hello from Ark" in 5 words or less.',
              },
            ],
          },
        ],
        [],
      );

      const textContent = response.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');

      console.log(`  Response: ${textContent}`);
      console.log(`  Stop reason: ${response.stop_reason}`);
      if (response.usage) {
        console.log(
          `  Tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`,
        );
      }
      console.log('  Ark test: ✅\n');
    } catch (error) {
      console.error(
        `  Ark test failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.log('  Ark test: ❌\n');
    }
  } else if (arkKey) {
    console.log(
      'Skipping Ark test: ARK_BASE_URL and ARK_MODEL must be set together with ARK_API_KEY.\n',
    );
  }

  console.log('Smoke test complete.');
}

// Run smoke test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runSmokeTest().catch((error) => {
    console.error(
      `Smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
