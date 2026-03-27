export type Scope = 'user' | 'agent' | 'global';

export interface MemoryRecord {
  id: string;
  userId: string;
  key: string;
  value: string;
  text: string;
  vector: number[];
  scope: Scope;
  createdAt: number;
  updatedAt: number;
  validFrom: number;
  validUntil: number;
  supersededBy: string;
}

export interface SearchResult {
  id: string;
  userId: string;
  key: string;
  value: string;
  text: string;
  scope: Scope;
  score: number;
  validFrom: number;
  validUntil: number;
}

export interface SearchOptions {
  topK?: number;
  scope?: Scope;
  rerank?: boolean;
  atTime?: number | Date;
  userId?: string;
}

export interface MemoryService {
  setUserId(userId: string): void;
  setFact(key: string, value: string): Promise<void>;
  getFact(key: string): Promise<string | null>;
  listFacts(): Promise<Array<{ key: string; value: string }>>;
  deleteFact(key: string): Promise<void>;
  index(
    id: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  search(
    query: string,
    topK?: number,
  ): Promise<Array<{ content: string; score: number }>>;
  buildContext(query: string): Promise<string | null>;

  remember(key: string, value: string, scope?: Scope): Promise<MemoryRecord>;
  forget(key: string, scope?: Scope): Promise<void>;
  searchAdvanced(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  listAll(scope?: Scope): Promise<MemoryRecord[]>;
  stats(): Promise<Record<Scope, number>>;
  getById(id: string): Promise<MemoryRecord | null>;
  deleteById(id: string): Promise<void>;

  getHistory(key: string, scope?: Scope): Promise<MemoryRecord[]>;
  searchAtTime(
    query: string,
    atTime: number | Date,
    opts?: Omit<SearchOptions, 'atTime'>,
  ): Promise<SearchResult[]>;
}
