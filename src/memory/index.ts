export { type MemoryService } from './types.js';
export { JsonMemoryService } from './json-memory.js';

import { JsonMemoryService } from './json-memory.js';
import type { MemoryService } from './types.js';

let globalMemory: MemoryService | null = null;

export function getMemory(): MemoryService {
  if (!globalMemory) {
    globalMemory = new JsonMemoryService();
  }
  return globalMemory;
}
