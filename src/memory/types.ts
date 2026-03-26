export interface MemoryService {
  setFact(key: string, value: string): Promise<void>;
  getFact(key: string): Promise<string | null>;
  listFacts(): Promise<Array<{ key: string; value: string }>>;
  deleteFact(key: string): Promise<void>;
  index(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  search(query: string, topK?: number): Promise<Array<{ content: string; score: number }>>;
  buildContext(query: string): Promise<string | null>;
}