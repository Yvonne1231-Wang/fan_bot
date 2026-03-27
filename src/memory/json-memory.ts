import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type {
  MemoryService,
  MemoryRecord,
  Scope,
  SearchResult,
  SearchOptions,
} from './types.js';

interface StoredFact {
  value: string;
  scope: Scope;
  validFrom: number;
  validUntil: number;
}

export class JsonMemoryService implements MemoryService {
  private factsPath: string;
  private facts: Map<string, StoredFact> = new Map();

  constructor(dir: string = '.memory') {
    this.factsPath = join(dir, 'facts.json');
  }

  private async ensureDir(): Promise<void> {
    await mkdir('.memory', { recursive: true });
  }

  private async loadFacts(): Promise<void> {
    try {
      const data = await readFile(this.factsPath, 'utf-8');
      const parsed = JSON.parse(data) as Record<string, StoredFact>;
      this.facts = new Map(Object.entries(parsed));
    } catch {
      this.facts = new Map();
    }
  }

  private async saveFacts(): Promise<void> {
    await this.ensureDir();
    const obj: Record<string, StoredFact> = {};
    for (const [key, val] of this.facts.entries()) {
      obj[key] = val;
    }
    await writeFile(this.factsPath, JSON.stringify(obj, null, 2), 'utf-8');
  }

  private isValidAtTime(fact: StoredFact, atTime: number): boolean {
    if (fact.validFrom > atTime) return false;
    if (fact.validUntil !== 0 && fact.validUntil < atTime) return false;
    return true;
  }

  async setFact(key: string, value: string): Promise<void> {
    await this.remember(key, value, 'user');
  }

  async getFact(key: string): Promise<string | null> {
    await this.loadFacts();
    const fact = this.facts.get(key);
    if (!fact || fact.validUntil !== 0) return null;
    return fact.value;
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
  ): Promise<void> {}

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

  async remember(
    key: string,
    value: string,
    scope: Scope = 'user',
  ): Promise<MemoryRecord> {
    await this.loadFacts();
    const now = Date.now();

    const existing = this.facts.get(key);
    if (existing && existing.validUntil === 0) {
      this.facts.set(key, {
        ...existing,
        validUntil: now,
      });
    }

    const record: StoredFact = {
      value,
      scope,
      validFrom: now,
      validUntil: 0,
    };
    this.facts.set(key, record);
    await this.saveFacts();

    return {
      id: key,
      key,
      value,
      text: `${key}: ${value}`,
      vector: [],
      scope,
      createdAt: existing?.validFrom ?? now,
      updatedAt: now,
      validFrom: now,
      validUntil: 0,
      supersededBy: '',
    };
  }

  async forget(key: string, scope?: Scope): Promise<void> {
    await this.loadFacts();
    const fact = this.facts.get(key);
    if (fact && (scope === undefined || fact.scope === scope)) {
      if (fact.validUntil === 0) {
        this.facts.set(key, {
          ...fact,
          validUntil: Date.now(),
        });
        await this.saveFacts();
      }
    }
  }

  async searchAdvanced(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchResult[]> {
    await this.loadFacts();
    const topK = opts?.topK ?? 5;
    const scope = opts?.scope;
    const atTime = opts?.atTime
      ? typeof opts.atTime === 'number'
        ? opts.atTime
        : opts.atTime.getTime()
      : Date.now();

    const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: SearchResult[] = [];

    for (const [key, fact] of this.facts.entries()) {
      if (!this.isValidAtTime(fact, atTime)) continue;
      if (scope && fact.scope !== scope) continue;

      const combined = `${key} ${fact.value}`.toLowerCase();
      let matches = 0;
      for (const word of queryWords) {
        if (combined.includes(word)) matches++;
      }
      if (matches > 0) {
        results.push({
          id: key,
          key,
          value: fact.value,
          text: `${key}: ${fact.value}`,
          scope: fact.scope,
          score: matches / queryWords.length,
          validFrom: fact.validFrom,
          validUntil: fact.validUntil,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async listAll(scope?: Scope): Promise<MemoryRecord[]> {
    await this.loadFacts();
    const now = Date.now();

    return Array.from(this.facts.entries())
      .filter(([, fact]) => fact.validUntil === 0)
      .filter(([, fact]) => !scope || fact.scope === scope)
      .map(([key, fact]) => ({
        id: key,
        key,
        value: fact.value,
        text: `${key}: ${fact.value}`,
        vector: [],
        scope: fact.scope,
        createdAt: fact.validFrom,
        updatedAt: now,
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        supersededBy: '',
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
    await this.loadFacts();
    const fact = this.facts.get(id);
    if (!fact) return null;

    return {
      id,
      key: id,
      value: fact.value,
      text: `${id}: ${fact.value}`,
      vector: [],
      scope: fact.scope,
      createdAt: fact.validFrom,
      updatedAt: fact.validUntil !== 0 ? fact.validUntil : Date.now(),
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
      supersededBy: '',
    };
  }

  async deleteById(id: string): Promise<void> {
    await this.forget(id);
  }

  async getHistory(key: string, scope?: Scope): Promise<MemoryRecord[]> {
    await this.loadFacts();
    const fact = this.facts.get(key);
    if (!fact) return [];
    if (scope && fact.scope !== scope) return [];

    return [
      {
        id: key,
        key,
        value: fact.value,
        text: `${key}: ${fact.value}`,
        vector: [],
        scope: fact.scope,
        createdAt: fact.validFrom,
        updatedAt: fact.validUntil !== 0 ? fact.validUntil : Date.now(),
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        supersededBy: '',
      },
    ];
  }

  async searchAtTime(
    query: string,
    atTime: number | Date,
    opts?: Omit<SearchOptions, 'atTime'>,
  ): Promise<SearchResult[]> {
    return this.searchAdvanced(query, { ...opts, atTime });
  }
}
