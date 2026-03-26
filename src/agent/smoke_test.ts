// ─── Agent Smoke Test ───────────────────────────────────────────────────────

import { config } from 'dotenv';
config();

import { createLLMClient, Provider } from '../llm/index.js';
import { runAgent } from './loop.js';
import { calculatorTool } from '../tools/calculator.js';
import { registry } from '../tools/registry.js';
import { Tool } from '../tools/types.js';

// ─── Test Functions ───────────────────────────────────────────────────────

/**
 * Run smoke tests for the agent.
 */
async function runSmokeTests(): Promise<void> {
  console.log('Running Agent smoke tests...\n');

  // Check environment
  const apiKey = process.env.ARK_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(
      'No API key found. Set ARK_API_KEY or ANTHROPIC_API_KEY to run smoke tests.',
    );
    console.log('Skipping smoke tests.\n');
    return;
  }

  // Register calculator tool
  registry.register(calculatorTool);
  console.log('✓ Calculator tool registered');

  // Determine provider
  const useArk = !!process.env.ARK_API_KEY;
  const provider = useArk ? Provider.Ark : Provider.Anthropic;

  // Create LLM client
  const llmClient = createLLMClient({
    provider,
    apiKey,
    baseURL: useArk ? process.env.ARK_BASE_URL : undefined,
    model: useArk ? process.env.ARK_MODEL : process.env.ANTHROPIC_MODEL,
  });
  console.log(`✓ LLM client created (${provider})\n`);

  // Test 1: Simple conversation (no tools)
  await testSimpleConversation(llmClient);

  // Test 2: Tool usage
  await testToolUsage(llmClient);

  // Test 3: Multi-turn conversation
  await testMultiTurnConversation(llmClient);

  console.log('\n✅ All smoke tests passed!\n');
}

/**
 * Test simple conversation without tools.
 */
async function testSimpleConversation(
  llmClient: ReturnType<typeof createLLMClient>,
): Promise<void> {
  console.log('Test 1: Simple conversation');
  console.log('-'.repeat(40));

  const result = await runAgent({
    prompt: 'Say "Hello from Agent" and nothing else.',
    llmClient,
    toolRegistry: {
      getSchemas: () => [],
      dispatch: async () => '',
      register: function (tool: Tool): void {
        throw new Error('Function not implemented.');
      },
    },
    maxIterations: 5,
  });

  console.log(`Response: ${result.response}`);
  console.log(`Iterations: ${result.iterations}`);
  console.log(
    `Tokens: ${result.usage?.inputTokens || 0} in / ${result.usage?.outputTokens || 0} out`,
  );
  console.log('✓ Simple conversation test passed\n');
}

/**
 * Test tool usage with calculator.
 */
async function testToolUsage(
  llmClient: ReturnType<typeof createLLMClient>,
): Promise<void> {
  console.log('Test 2: Tool usage (calculator)');
  console.log('-'.repeat(40));

  const result = await runAgent({
    prompt: 'Calculate 123 + 456 using the calculator tool.',
    llmClient,
    toolRegistry: {
      getSchemas: () => [
        {
          name: 'calculator',
          description: 'Perform basic arithmetic calculations',
          input_schema: {
            type: 'object',
            properties: {
              operation: {
                type: 'string',
                enum: ['add', 'subtract', 'multiply', 'divide'],
              },
              a: { type: 'number' },
              b: { type: 'number' },
            },
            required: ['operation', 'a', 'b'],
          },
        },
      ],
      dispatch: async (name: string, input: Record<string, unknown>) => {
        if (name === 'calculator') {
          const a = Number(input.a);
          const b = Number(input.b);
          switch (input.operation) {
            case 'add':
              return String(a + b);
            case 'subtract':
              return String(a - b);
            case 'multiply':
              return String(a * b);
            case 'divide':
              return b === 0 ? 'Error: Division by zero' : String(a / b);
            default:
              throw new Error('Unknown operation');
          }
        }
        throw new Error(`Unknown tool: ${name}`);
      },
      register: function (tool: Tool): void {
        throw new Error('Function not implemented.');
      },
    },
    maxIterations: 5,
  });

  console.log(`Response: ${result.response}`);
  console.log(`Iterations: ${result.iterations}`);
  console.log(
    `Tokens: ${result.usage?.inputTokens || 0} in / ${result.usage?.outputTokens || 0} out`,
  );

  // Verify result contains 579
  if (!result.response.includes('579')) {
    throw new Error('Expected result to contain 579');
  }
  console.log('✓ Tool usage test passed\n');
}

/**
 * Test multi-turn conversation.
 */
async function testMultiTurnConversation(
  llmClient: ReturnType<typeof createLLMClient>,
): Promise<void> {
  console.log('Test 3: Multi-turn conversation');
  console.log('-'.repeat(40));

  // First turn
  const result1 = await runAgent({
    prompt: 'Remember this number: 42. Just say "OK".',
    llmClient,
    toolRegistry: {
      getSchemas: () => [],
      dispatch: async () => '',
      register: function (tool: Tool): void {
        throw new Error('Function not implemented.');
      },
    },
    maxIterations: 3,
  });

  console.log(`Turn 1 - Response: ${result1.response}`);
  console.log(`Turn 1 - Iterations: ${result1.iterations}`);

  // Second turn (using initial messages from first turn)
  const result2 = await runAgent({
    prompt: 'What number did I ask you to remember?',
    llmClient,
    toolRegistry: {
      getSchemas: () => [],
      dispatch: async () => '',
      register: function (tool: Tool): void {
        throw new Error('Function not implemented.');
      },
    },
    initialMessages: result1.messages,
    maxIterations: 3,
  });

  console.log(`Turn 2 - Response: ${result2.response}`);
  console.log(`Turn 2 - Iterations: ${result2.iterations}`);

  // Verify it remembered
  if (!result2.response.includes('42')) {
    throw new Error('Expected response to contain 42 (the remembered number)');
  }
  console.log('✓ Multi-turn conversation test passed\n');
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  runSmokeTests().catch((error) => {
    console.error('\n❌ Smoke test failed:', error);
    process.exit(1);
  });
}
