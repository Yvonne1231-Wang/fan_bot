// ─── Calculator Tool ────────────────────────────────────────────────────────

import type { Tool } from './types.js';

/**
 * A simple calculator tool that performs basic arithmetic operations.
 */
export const calculatorTool: Tool = {
  schema: {
    name: 'calculator',
    description: 'Perform basic arithmetic calculations (add, subtract, multiply, divide)',
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['add', 'subtract', 'multiply', 'divide'],
          description: 'The arithmetic operation to perform',
        },
        a: {
          type: 'number',
          description: 'The first number',
        },
        b: {
          type: 'number',
          description: 'The second number',
        },
      },
      required: ['operation', 'a', 'b'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const operation = String(input.operation);
    const a = Number(input.a);
    const b = Number(input.b);

    // Validate inputs
    if (isNaN(a) || isNaN(b)) {
      throw new Error('Invalid numbers provided');
    }

    let result: number;

    switch (operation) {
      case 'add':
        result = a + b;
        break;
      case 'subtract':
        result = a - b;
        break;
      case 'multiply':
        result = a * b;
        break;
      case 'divide':
        if (b === 0) {
          throw new Error('Division by zero');
        }
        result = a / b;
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    return String(result);
  },
};
