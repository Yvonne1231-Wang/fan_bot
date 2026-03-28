import * as lancedb from '@lancedb/lancedb';
import type {
  MemoryService,
  MemoryRecord,
  Scope,
  SearchResult,
  SearchOptions,
} from './types.js';
import type { LLMClient } from '../llm/types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('memory:lancedb');

type InternalRecord = Record<string, unknown> & {
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
};

const SIMILARITY_THRESHOLD = 0.85;
const EMBEDDING_DIMENSION = 768;
const TABLE_NAME = 'memories';
const RRF_K = 60;

const JINA_API_URL = 'https://api.jina.ai/v1';
const JINA_EMBEDDING_MODEL = 'jina-embeddings-v2-base-en';

export class LanceDBMemoryService implements MemoryService {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private jinaApiKey: string | null = null;
  private llmClient: LLMClient | null = null;
  private dbPath: string;
  private initPromise: Promise<void> | null = null;
  private currentUserId: string = 'default';

  constructor(dbPath: string = '.memory/lancedb', llmClient?: LLMClient) {
    this.dbPath = dbPath;
    this.llmClient = llmClient || null;
  }

  setUserId(userId: string): void {
    this.currentUserId = userId;
    log.debug(`Set current user: ${userId}`);
  }

  setLLMClient(client: LLMClient): void {
    this.llmClient = client;
  }

  private async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    log.debug(`Initializing LanceDB at ${this.dbPath}`);

    this.db = await lancedb.connect(this.dbPath);

    const jinaKey = process.env.JINA_API_KEY;
    if (!jinaKey) {
      throw new Error(
        'JINA_API_KEY environment variable is required for embeddings',
      );
    }
    this.jinaApiKey = jinaKey;

    const existingTables = await this.db.tableNames();
    if (existingTables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
      log.debug('Opened existing memories table');
    } else {
      const now = Date.now();
      const seedData: InternalRecord[] = [
        {
          id: '__seed__',
          userId: '__seed__',
          key: '__seed__',
          value: '__seed__',
          text: '__seed__',
          vector: new Array(EMBEDDING_DIMENSION).fill(0),
          scope: 'user',
          createdAt: now,
          updatedAt: now,
          validFrom: now,
          validUntil: 0,
          supersededBy: '',
        },
      ];
      this.table = await this.db.createTable(TABLE_NAME, seedData, {
        mode: 'overwrite',
      });
      await this.table.delete("id = '__seed__'");
      log.debug('Created new memories table');
    }
  }

  private async embed(text: string): Promise<number[]> {
    if (!this.jinaApiKey) {
      throw new Error('Jina API key not initialized');
    }

    const response = await fetch(`${JINA_API_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.jinaApiKey}`,
      },
      body: JSON.stringify({
        model: JINA_EMBEDDING_MODEL,
        input: [text],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jina embedding API error: ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data[0].embedding;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private escapeSQL(str: string): string {
    return str.replace(/'/g, "''");
  }

  private buildBM25WhereClause(
    userId: string,
    scope: Scope | undefined,
    atTime: number,
  ): string {
    const conditions: string[] = [];

    conditions.push("id != '__seed__'");
    conditions.push(`validFrom <= ${atTime}`);
    conditions.push(`(validUntil = 0 OR validUntil > ${atTime})`);
    conditions.push(
      `(scope = 'global' OR userId = '${this.escapeSQL(userId)}')`,
    );

    if (scope) {
      conditions.push(`scope = '${scope}'`);
    }

    return conditions.join(' AND ');
  }

  private parseScope(scopeStr?: string): Scope {
    if (scopeStr === 'user' || scopeStr === 'agent' || scopeStr === 'global') {
      return scopeStr;
    }
    return 'user';
  }

  private isValidAtTime(record: InternalRecord, atTime: number): boolean {
    if (record.validFrom > atTime) return false;
    if (record.validUntil !== 0 && record.validUntil < atTime) return false;
    return true;
  }

  private matchesUser(record: InternalRecord, userId?: string): boolean {
    const targetUser = userId || this.currentUserId;
    if (record.scope === 'global') return true;
    return record.userId === targetUser;
  }

  private rrfMerge(
    vectorResults: InternalRecord[],
    bm25Results: InternalRecord[],
    topK: number,
  ): Array<{ record: InternalRecord; score: number }> {
    const scores = new Map<string, number>();

    for (let i = 0; i < vectorResults.length; i++) {
      const record = vectorResults[i];
      if (record.id === '__seed__') continue;
      const rrfScore = 1 / (RRF_K + i + 1);
      scores.set(record.id, (scores.get(record.id) || 0) + rrfScore);
    }

    for (let i = 0; i < bm25Results.length; i++) {
      const record = bm25Results[i];
      if (record.id === '__seed__') continue;
      const rrfScore = 1 / (RRF_K + i + 1);
      scores.set(record.id, (scores.get(record.id) || 0) + rrfScore);
    }

    const recordMap = new Map<string, InternalRecord>();
    for (const r of [...vectorResults, ...bm25Results]) {
      if (!recordMap.has(r.id)) {
        recordMap.set(r.id, r);
      }
    }

    const merged = Array.from(scores.entries())
      .map(([id, score]) => ({ record: recordMap.get(id)!, score }))
      .filter((item) => item.record && item.record.id !== '__seed__')
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return merged;
  }

  private async rerankWithLLM(
    query: string,
    candidates: InternalRecord[],
    topK: number,
  ): Promise<Array<{ record: InternalRecord; score: number }>> {
    if (!this.llmClient || candidates.length === 0) {
      return candidates
        .slice(0, topK)
        .map((r, i) => ({ record: r, score: 1 - i * 0.1 }));
    }

    log.debug(`Reranking ${candidates.length} candidates with LLM`);

    const candidateTexts = candidates
      .map((c, i) => `[${i}] ${c.text}`)
      .join('\n');

    const prompt = `You are a relevance scoring system. Score each candidate's relevance to the query.

Query: ${query}

Candidates:
${candidateTexts}

For each candidate, output a score from 0.0 to 1.0 indicating relevance.
Output format: one line per candidate as "index:score" (e.g., "0:0.9")
Only output the scores, nothing else.`;

    try {
      const response = await this.llmClient.chat(
        [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        [],
        undefined,
      );

      const text = response.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');

      const scorePattern = /(\d+)\s*[:\s]\s*([\d.]+)/g;
      const scores = new Map<number, number>();
      let match;
      while ((match = scorePattern.exec(text)) !== null) {
        const idx = parseInt(match[1], 10);
        const score = parseFloat(match[2]);
        if (
          !isNaN(idx) &&
          !isNaN(score) &&
          idx >= 0 &&
          idx < candidates.length
        ) {
          scores.set(idx, Math.min(1, Math.max(0, score)));
        }
      }

      const results = candidates.map((r, i) => ({
        record: r,
        score: scores.get(i) ?? 0.5,
      }));

      return results.sort((a, b) => b.score - a.score).slice(0, topK);
    } catch (error) {
      log.warn(
        `Rerank failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return candidates
        .slice(0, topK)
        .map((r, i) => ({ record: r, score: 1 - i * 0.1 }));
    }
  }

  async remember(
    key: string,
    value: string,
    scope: Scope = 'user',
  ): Promise<MemoryRecord> {
    await this.initialize();
    if (!this.table) throw new Error('Table not initialized');

    log.debug(
      `Remembering: ${key} = ${value} (scope: ${scope}, user: ${this.currentUserId})`,
    );

    const text = `${key}: ${value}`;
    const vector = await this.embed(text);
    const now = Date.now();

    const validRecords = (await this.table
      .query()
      .where(
        `key = '${this.escapeSQL(key)}' AND scope = '${scope}' AND userId = '${this.escapeSQL(this.currentUserId)}' AND validUntil = 0`,
      )
      .toArray()) as InternalRecord[];

    if (validRecords.length > 0) {
      const existing = validRecords[0];
      const newId = crypto.randomUUID();

      await this.table.update({
        where: `id = '${existing.id}'`,
        values: {
          validUntil: now,
          supersededBy: newId,
        },
      });

      const newRecord: InternalRecord = {
        id: newId,
        userId: this.currentUserId,
        key,
        value,
        text,
        vector,
        scope,
        createdAt: existing.createdAt,
        updatedAt: now,
        validFrom: now,
        validUntil: 0,
        supersededBy: '',
      };
      await this.table.add([newRecord]);
      return newRecord as MemoryRecord;
    }

    const id = crypto.randomUUID();
    const record: InternalRecord = {
      id,
      userId: this.currentUserId,
      key,
      value,
      text,
      vector,
      scope,
      createdAt: now,
      updatedAt: now,
      validFrom: now,
      validUntil: 0,
      supersededBy: '',
    };
    await this.table.add([record]);
    return record as MemoryRecord;
  }

  async forget(key: string, scope?: Scope): Promise<void> {
    await this.initialize();
    if (!this.table) throw new Error('Table not initialized');

    log.debug(
      `Forgetting: ${key} (scope: ${scope || 'all'}, user: ${this.currentUserId})`,
    );

    let whereClause = `key = '${this.escapeSQL(key)}' AND userId = '${this.escapeSQL(this.currentUserId)}' AND validUntil = 0`;
    if (scope) {
      whereClause += ` AND scope = '${scope}'`;
    }

    const records = (await this.table
      .query()
      .where(whereClause)
      .toArray()) as InternalRecord[];

    const now = Date.now();
    for (const record of records) {
      await this.table.update({
        where: `id = '${record.id}'`,
        values: {
          validUntil: now,
          supersededBy: '',
        },
      });
    }
  }

  async searchAdvanced(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchResult[]> {
    await this.initialize();
    if (!this.table) throw new Error('Table not initialized');

    const topK = opts?.topK ?? 5;
    const scope = opts?.scope;
    const useRerank = opts?.rerank ?? false;
    const targetUserId = opts?.userId || this.currentUserId;
    const atTime = opts?.atTime
      ? typeof opts.atTime === 'number'
        ? opts.atTime
        : opts.atTime.getTime()
      : Date.now();

    log.debug(
      `Advanced search: "${query}" (topK: ${topK}, scope: ${scope}, user: ${targetUserId}, rerank: ${useRerank})`,
    );

    const queryVector = await this.embed(query);

    let vectorResults = (await this.table
      .vectorSearch(queryVector)
      .limit(topK * 5)
      .toArray()) as InternalRecord[];

    vectorResults = vectorResults.filter(
      (r) =>
        r.id !== '__seed__' &&
        this.isValidAtTime(r, atTime) &&
        this.matchesUser(r, targetUserId) &&
        (!scope || r.scope === scope),
    );

    const bm25Results: InternalRecord[] = [];
    try {
      const queryWords = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1);
      if (queryWords.length > 0) {
        const whereClause = this.buildBM25WhereClause(
          targetUserId,
          scope,
          atTime,
        );

        // 限制 BM25 扫描数量，只取最近的记录
        const BM25_SCAN_LIMIT = 500;
        let allRecords = (await this.table
          .query()
          .where(whereClause)
          .limit(BM25_SCAN_LIMIT)
          .toArray()) as InternalRecord[];

        if (allRecords.length > 0) {
          const scored = allRecords
            .map((r) => {
              const textLower = r.text.toLowerCase();
              let matches = 0;
              for (const word of queryWords) {
                if (textLower.includes(word)) matches++;
              }
              return { record: r, matches };
            })
            .filter((item) => item.matches > 0)
            .sort((a, b) => b.matches - a.matches)
            .slice(0, topK * 2);

          bm25Results.push(...scored.map((s) => s.record));
        }
      }
    } catch (error) {
      log.warn(
        `BM25 search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const merged = this.rrfMerge(
      vectorResults,
      bm25Results,
      useRerank ? topK * 2 : topK,
    );

    let finalResults: Array<{ record: InternalRecord; score: number }>;
    if (useRerank && this.llmClient) {
      finalResults = await this.rerankWithLLM(
        query,
        merged.map((m) => m.record),
        topK,
      );
    } else {
      finalResults = merged.slice(0, topK);
    }

    return finalResults.map((r) => ({
      id: r.record.id,
      userId: r.record.userId,
      key: r.record.key,
      value: r.record.value,
      text: r.record.text,
      scope: r.record.scope,
      score: r.score,
      validFrom: r.record.validFrom,
      validUntil: r.record.validUntil,
    }));
  }

  async listAll(scope?: Scope): Promise<MemoryRecord[]> {
    await this.initialize();
    if (!this.table) throw new Error('Table not initialized');

    let records = (await this.table.query().toArray()) as InternalRecord[];
    records = records.filter((r) => r.id !== '__seed__');
    records = records.filter((r) => r.validUntil === 0);
    records = records.filter((r) => this.matchesUser(r));

    if (scope) {
      records = records.filter((r) => r.scope === scope);
    }

    return records.map((r) => ({
      id: r.id,
      userId: r.userId,
      key: r.key,
      value: r.value,
      text: r.text,
      vector: r.vector,
      scope: r.scope,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      supersededBy: r.supersededBy,
    }));
  }

  async stats(): Promise<Record<Scope, number>> {
    const records = await this.listAll();
    return {
      user: records.filter((r) => r.scope === 'user').length,
      agent: records.filter((r) => r.scope === 'agent').length,
      global: records.filter((r) => r.scope === 'global').length,
    };
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    await this.initialize();
    if (!this.table) throw new Error('Table not initialized');

    const records = (await this.table
      .query()
      .where(`id = '${this.escapeSQL(id)}'`)
      .limit(1)
      .toArray()) as InternalRecord[];

    if (records.length === 0) return null;

    const r = records[0];
    return {
      id: r.id,
      userId: r.userId,
      key: r.key,
      value: r.value,
      text: r.text,
      vector: r.vector,
      scope: r.scope,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      supersededBy: r.supersededBy,
    };
  }

  async deleteById(id: string): Promise<void> {
    await this.initialize();
    if (!this.table) throw new Error('Table not initialized');

    log.debug(`Deleting by id: ${id}`);
    await this.table.delete(`id = '${this.escapeSQL(id)}'`);
  }

  async getHistory(key: string, scope?: Scope): Promise<MemoryRecord[]> {
    await this.initialize();
    if (!this.table) throw new Error('Table not initialized');

    let whereClause = `key = '${this.escapeSQL(key)}' AND userId = '${this.escapeSQL(this.currentUserId)}'`;
    if (scope) {
      whereClause += ` AND scope = '${scope}'`;
    }

    const records = (await this.table
      .query()
      .where(whereClause)
      .toArray()) as InternalRecord[];

    return records
      .filter((r) => r.id !== '__seed__')
      .sort((a, b) => b.validFrom - a.validFrom)
      .map((r) => ({
        id: r.id,
        userId: r.userId,
        key: r.key,
        value: r.value,
        text: r.text,
        vector: r.vector,
        scope: r.scope,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        validFrom: r.validFrom,
        validUntil: r.validUntil,
        supersededBy: r.supersededBy,
      }));
  }

  async searchAtTime(
    query: string,
    atTime: number | Date,
    opts?: Omit<SearchOptions, 'atTime'>,
  ): Promise<SearchResult[]> {
    return this.searchAdvanced(query, { ...opts, atTime });
  }

  async setFact(key: string, value: string): Promise<void> {
    await this.remember(key, value, 'user');
  }

  async getFact(key: string): Promise<string | null> {
    await this.initialize();
    if (!this.table) throw new Error('Table not initialized');

    const records = (await this.table
      .query()
      .where(
        `key = '${this.escapeSQL(key)}' AND userId = '${this.escapeSQL(this.currentUserId)}' AND validUntil = 0`,
      )
      .limit(1)
      .toArray()) as InternalRecord[];

    return records.length > 0 ? records[0].value : null;
  }

  async listFacts(): Promise<Array<{ key: string; value: string }>> {
    const records = await this.listAll();
    return records.map((r) => ({ key: r.key, value: r.value }));
  }

  async deleteFact(key: string): Promise<void> {
    await this.forget(key);
  }

  async index(
    _id: string,
    _content: string,
    _metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.initialize();
  }

  async search(
    query: string,
    topK: number = 5,
  ): Promise<Array<{ content: string; score: number }>> {
    const results = await this.searchAdvanced(query, { topK });
    return results.map((r) => ({ content: r.text, score: r.score }));
  }

  async buildContext(query: string): Promise<string | null> {
    const facts = await this.listFacts();
    if (facts.length === 0) return null;

    const results = await this.searchAdvanced(query, { topK: 5 });
    if (results.length === 0) return null;

    return (
      '[MEMORY]\n' +
      results.map((r) => `- ${r.text}`).join('\n') +
      '\n[/MEMORY]'
    );
  }
}
