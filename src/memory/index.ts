export {
  type MemoryService,
  type MemoryRecord,
  type Scope,
  type SearchResult,
} from './types.js';
export { JsonMemoryService } from './json-memory.js';
export { LanceDBMemoryService } from './lancedb-memory.js';

import { LanceDBMemoryService } from './lancedb-memory.js';
import type { MemoryService } from './types.js';

let globalMemory: MemoryService | null = null;

export function getMemory(): MemoryService {
  if (!globalMemory) {
    globalMemory = new LanceDBMemoryService();
  }
  return globalMemory;
}
