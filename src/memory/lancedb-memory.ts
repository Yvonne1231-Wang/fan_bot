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
  accessCount: number;
  lastAccessedAt: number;
};

const SIMILARITY_THRESHOLD = 0.85;
const EMBEDDING_DIMENSION = 768;
const TABLE_NAME = 'memories';
const RRF_K = 60;

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const BM25_AVGDL_SAMPLE_SIZE = 1000;

const RECENCY_HALF_LIFE_DAYS = 14;
const RECENCY_WEIGHT = 0.1;

const ACCESS_DECAY_HALF_LIFE_DAYS = 30;
const REINFORCEMENT_FACTOR = 0.5;
const MAX_HALF_LIFE_MULTIPLIER = 3;

const LENGTH_NORM_ANCHOR = 500;

const RERANK_API_URL = 'https://api.jina.ai/v1';
const RERANK_MODEL = 'jina-reranker-v3';
const CROSS_ENCODER_WEIGHT = 0.6;
const ORIGINAL_SCORE_WEIGHT = 0.4;

const JINA_API_BASE_URL = process.env.JINA_API_BASE_URL || 'https://api.jina.ai/v1';
const JINA_EMBEDDING_MODEL = process.env.JINA_EMBEDDING_MODEL || 'jina-embeddings-v2-base-en';

export class LanceDBMemoryService implements MemoryService {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private jinaApiKey: string | null = null;
  private llmClient: LLMClient | null = null;
  private dbPath: string;
  private initPromise: Promise<void> | null = null;
  private currentUserId: string = 'default';

  private accessTracker: Map<string, { count: number; lastAccess: number }> =
    new Map();
  private accessFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ACCESS_FLUSH_INTERVAL_MS = 5000;

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
          accessCount: 0,
          lastAccessedAt: now,
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

    const response = await fetch(`${JINA_API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.jinaApiKey}`,
      },
      body: JSON.stringify({
        model: JINA_EMBEDDING_MODEL,
        messages: [
          {
            role: 'user',
            content: text,
          },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jina embedding API error: ${error}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string;
        };
      }>;
    };

    const embeddingStr = data.choices[0]?.message?.content;
    if (!embeddingStr) {
      throw new Error('Empty embedding response');
    }

    const embedding = JSON.parse(embeddingStr) as number[];
    return embedding;
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

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);
  }

  private isNoiseContent(text: string): boolean {
    const lower = text.toLowerCase().trim();

    const refusalPatterns = [
      /^sorry,?\s/i,
      /^i can't\s/i,
      /^i cannot\s/i,
      /^unable to\s/i,
      /^i'm sorry,?\s/i,
      /^i don'?t have\s/i,
      /^i don'?t know\s/i,
      /^that (would be|goes beyond|s request)/i,
      /^as an ai,?\s/i,
      /^i'?m an?\s/i,
      /^i was?n'?t designed\s/i,
    ];

    if (refusalPatterns.some((p) => p.test(lower))) {
      return true;
    }

    const greetingPatterns = [
      /^(hi|hello|hey|greetings|howdy|hiya),?\s*/i,
      /^(good (morning|afternoon|evening|day)),?\s*/i,
      /^hey there!?\s*$/i,
    ];

    if (greetingPatterns.some((p) => p.test(lower)) && lower.length < 50) {
      return true;
    }

    const metaPatterns = [
      /^what do you mean/i,
      /^what do you think/i,
      /^can you clarify/i,
      /^could you explain/i,
      /^i need help/i,
      /^help me/i,
      /^tell me about yourself/i,
      /^who are you/i,
    ];

    if (metaPatterns.some((p) => p.test(lower)) && lower.length < 100) {
      return true;
    }

    const confirmationPatterns = [
      /^(yes|yep|yeah|correct|right|ok|okay|sounds good|agreed),?\s*$/i,
      /^(no|nope|nah|incorrect|wrong),?\s*$/i,
      /^(thank you|thanks),?\s*$/i,
    ];

    if (confirmationPatterns.some((p) => p.test(lower)) && lower.length < 30) {
      return true;
    }

    return false;
  }

  private async computeBM25Scores(
    queryWords: string[],
    records: InternalRecord[],
    avgDocLen: number,
  ): Promise<Map<string, number>> {
    const N = records.length;
    const docFreqs = new Map<string, number>();

    for (const word of queryWords) {
      docFreqs.set(word, 0);
    }

    for (const record of records) {
      const docWords = new Set(this.tokenize(record.text));
      for (const word of queryWords) {
        if (docWords.has(word)) {
          docFreqs.set(word, (docFreqs.get(word) || 0) + 1);
        }
      }
    }

    const scores = new Map<string, number>();

    for (const record of records) {
      const docWords = this.tokenize(record.text);
      const docLen = docWords.length;
      const wordCounts = new Map<string, number>();
      for (const word of docWords) {
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
      }

      let score = 0;
      for (const word of queryWords) {
        const df = docFreqs.get(word) || 0;
        if (df === 0) continue;

        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const tf = wordCounts.get(word) || 0;
        const numerator = tf * (BM25_K1 + 1);
        const denominator =
          tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen));
        score += idf * (numerator / denominator);
      }

      scores.set(record.id, score);
    }

    return scores;
  }

  private async estimateAverageDocLength(
    records: InternalRecord[],
    sampleSize: number,
  ): Promise<number> {
    const sample = records.slice(0, sampleSize);
    const totalLen = sample.reduce(
      (sum, r) => sum + this.tokenize(r.text).length,
      0,
    );
    return totalLen / Math.max(sample.length, 1);
  }

  private computeRecencyBoost(record: InternalRecord, now: number): number {
    const daysSinceLastAccess =
      (now - (record.lastAccessedAt || record.createdAt)) /
      (24 * 60 * 60 * 1000);

    const accessFreshness = Math.exp(
      (-daysSinceLastAccess * Math.log(2)) / ACCESS_DECAY_HALF_LIFE_DAYS,
    );
    const effectiveAccessCount = (record.accessCount || 0) * accessFreshness;

    const extension =
      RECENCY_HALF_LIFE_DAYS *
      REINFORCEMENT_FACTOR *
      Math.log(1 + effectiveAccessCount);
    const effectiveHalfLife = Math.min(
      RECENCY_HALF_LIFE_DAYS + extension,
      RECENCY_HALF_LIFE_DAYS * MAX_HALF_LIFE_MULTIPLIER,
    );

    const ageMs = now - record.createdAt;
    const halfLifeMs = effectiveHalfLife * 24 * 60 * 60 * 1000;
    const ageInHalfLives = ageMs / halfLifeMs;
    const decayFactor = Math.pow(0.5, ageInHalfLives);

    return 1 + RECENCY_WEIGHT * decayFactor;
  }

  private recordAccess(recordId: string): void {
    const now = Date.now();
    const existing = this.accessTracker.get(recordId);
    if (existing) {
      existing.count += 1;
      existing.lastAccess = now;
    } else {
      this.accessTracker.set(recordId, { count: 1, lastAccess: now });
    }

    if (!this.accessFlushTimer) {
      this.accessFlushTimer = setTimeout(() => {
        this.flushAccessCounts().catch((err) => {
          log.warn(`Failed to flush access counts: ${err}`);
        });
      }, this.ACCESS_FLUSH_INTERVAL_MS);
    }
  }

  private async flushAccessCounts(): Promise<void> {
    if (!this.table || this.accessTracker.size === 0) return;

    const timer = this.accessFlushTimer;
    if (timer) {
      clearTimeout(timer);
      this.accessFlushTimer = null;
    }

    const entries = Array.from(this.accessTracker.entries());
    this.accessTracker.clear();

    for (const [recordId, { count, lastAccess }] of entries) {
      try {
        await this.table.update({
          where: `id = '${this.escapeSQL(recordId)}'`,
          values: {
            accessCount: count,
            lastAccessedAt: lastAccess,
          },
        });
      } catch (err) {
        log.warn(`Failed to update access count for ${recordId}: ${err}`);
        this.accessTracker.set(recordId, { count, lastAccess });
      }
    }
  }

  private applyRecencyBoost(
    results: Array<{ record: InternalRecord; score: number }>,
    now: number,
  ): Array<{ record: InternalRecord; score: number }> {
    return results.map((item) => ({
      ...item,
      score: item.score * this.computeRecencyBoost(item.record, now),
    }));
  }

  private applyLengthNorm(
    results: Array<{ record: InternalRecord; score: number }>,
  ): Array<{ record: InternalRecord; score: number }> {
    return results.map((item) => {
      const textLen = item.record.text.length;
      const normFactor = LENGTH_NORM_ANCHOR / Math.max(textLen, 1);
      const balancedFactor = Math.sqrt(normFactor);
      return {
        ...item,
        score: item.score * balancedFactor,
      };
    });
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
    if (candidates.length === 0) {
      return [];
    }

    if (!this.llmClient && !this.jinaApiKey) {
      return candidates
        .slice(0, topK)
        .map((r, i) => ({ record: r, score: 1 - i * 0.1 }));
    }

    let rerankScores: Map<number, number>;

    if (this.jinaApiKey) {
      rerankScores = await this.rerankWithJina(query, candidates);
    } else {
      rerankScores = await this.rerankWithLLMPrompt(query, candidates);
    }

    const results = candidates.map((r, i) => ({
      record: r,
      score: rerankScores.get(i) ?? 0.5,
    }));

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  private async rerankWithJina(
    query: string,
    candidates: InternalRecord[],
  ): Promise<Map<number, number>> {
    if (!this.jinaApiKey) {
      return this.rerankWithLLMPrompt(query, candidates);
    }

    log.debug(
      `Reranking ${candidates.length} candidates with Jina cross-encoder`,
    );

    try {
      const response = await fetch(`${RERANK_API_URL}/rerank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.jinaApiKey}`,
        },
        body: JSON.stringify({
          model: RERANK_MODEL,
          query,
          documents: candidates.map((c) => c.text),
          top_n: candidates.length,
        }),
      });

      if (!response.ok) {
        log.warn(`Jina rerank API failed: ${response.status}`);
        return this.rerankWithLLMPrompt(query, candidates);
      }

      const data = (await response.json()) as {
        results: Array<{ index: number; relevance_score: number }>;
      };

      const scores = new Map<number, number>();
      for (const result of data.results) {
        scores.set(result.index, result.relevance_score);
      }

      return scores;
    } catch (error) {
      log.warn(
        `Jina rerank failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.rerankWithLLMPrompt(query, candidates);
    }
  }

  private async rerankWithLLMPrompt(
    query: string,
    candidates: InternalRecord[],
  ): Promise<Map<number, number>> {
    if (!this.llmClient) {
      const scores = new Map<number, number>();
      candidates.forEach((_, i) => scores.set(i, 1 - i * 0.1));
      return scores;
    }

    log.debug(`Reranking ${candidates.length} candidates with LLM prompt`);

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

      if (scores.size === 0) {
        candidates.forEach((_, i) => scores.set(i, 0.5));
      }

      return scores;
    } catch (error) {
      log.warn(
        `LLM rerank failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const scores = new Map<number, number>();
      candidates.forEach((_, i) => scores.set(i, 1 - i * 0.1));
      return scores;
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
        accessCount: 0,
        lastAccessedAt: now,
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
      accessCount: 0,
      lastAccessedAt: now,
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
        (!scope || r.scope === scope) &&
        ((r as Record<string, unknown>)._distance as number) <=
          1 - SIMILARITY_THRESHOLD,
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
          const avgDocLen = await this.estimateAverageDocLength(
            allRecords,
            BM25_AVGDL_SAMPLE_SIZE,
          );
          const bm25Scores = await this.computeBM25Scores(
            queryWords,
            allRecords,
            avgDocLen,
          );

          const scored = allRecords
            .map((r) => ({ record: r, score: bm25Scores.get(r.id) || 0 }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score)
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

    const boostedResults = this.applyRecencyBoost(merged, Date.now());
    const normalizedResults = this.applyLengthNorm(boostedResults);

    let finalResults: Array<{ record: InternalRecord; score: number }>;
    if (useRerank && this.llmClient) {
      finalResults = await this.rerankWithLLM(
        query,
        normalizedResults.map((m) => m.record),
        topK,
      );
    } else {
      finalResults = normalizedResults.slice(0, topK);
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
    if (!this.shouldRetrieve(query)) {
      log.debug(`Skipping retrieval for query: "${query}"`);
      return null;
    }

    const results = await this.searchAdvanced(query, { topK: 5 });
    if (results.length === 0) return null;

    for (const result of results) {
      this.recordAccess(result.id);
    }

    return (
      '[MEMORY]\n' +
      results.map((r) => `- ${r.text}`).join('\n') +
      '\n[/MEMORY]'
    );
  }

  private shouldRetrieve(query: string): boolean {
    const text = query.trim();

    if (text === 'HEARTBEAT') return false;

    if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u.test(text)) {
      return false;
    }

    const greetingPatterns = [
      /^(hi|hello|hey|greetings|howdy|hiya)[.!]*\s*$/i,
      /^(good (morning|afternoon|evening|day))[.!]*$/i,
      /^hey there[.!]*$/i,
      /^hi there[.!]*$/i,
    ];
    if (greetingPatterns.some((p) => p.test(text))) return false;

    const commandPatterns = [
      /^\/\w+/,
      /^(git|npm|yarn|pnpm|docker|kubectl|make|cmake)\s+/,
      /^pip\s+/,
      /^cargo\s+/,
      /^go\s+(get|build|run|test)/,
    ];
    if (commandPatterns.some((p) => p.test(text))) return false;

    const confirmationPatterns = [
      /^(yes|yep|yeah|yup|correct|right|ok|okay|sure|agreed)[.!]*$/i,
      /^(no|nope|nah|incorrect|wrong)[.!]*$/i,
      /^(thank you|thanks)[.!]*$/i,
      /^(好的|可以|行|没问题|同意)[.!]*$/i,
      /^(嗯|好|是的|对)[.!]*$/i,
    ];
    if (confirmationPatterns.some((p) => p.test(text))) return false;

    const memoryKeywords = [
      /\b(remember|recall|memory|forget|forgot)\b/i,
      /\b(你记得|记得之前|上次|以前|曾经)\b/u,
      /\b(过去|历史|过去的事)\b/u,
    ];
    if (memoryKeywords.some((p) => p.test(text))) return true;

    const personalInfoKeywords = [
      /\b(my name|my email|my password|my phone|my address|my preference|my hobby)\b/i,
      /\b(我的名字|我的邮箱|我的密码|我的电话|我的地址|我的偏好)\b/u,
    ];
    if (personalInfoKeywords.some((p) => p.test(text))) return true;

    const isChinese = /[\u4e00-\u9fff]/.test(text);
    if (isChinese) {
      if (text.length < 6 && !text.includes('?')) return false;
    } else {
      if (text.length < 15 && !text.includes('?')) return false;
    }

    return true;
  }
}
