import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { MemoryService } from './types.js';

interface StoredFact {
  key: string;
  value: string;
}

export class JsonMemoryService implements MemoryService {
  private factsPath: string;
  private facts: Map<string, string> = new Map();

  constructor(dir: string = '.memory') {
    this.factsPath = join(dir, 'facts.json');
  }

  private async ensureDir(): Promise<void> {
    await mkdir('.memory', { recursive: true });
  }

  private async loadFacts(): Promise<void> {
    try {
      const data = await readFile(this.factsPath, 'utf-8');
      const parsed = JSON.parse(data) as Record<string, string>;
      this.facts = new Map(Object.entries(parsed));
    } catch {
      this.facts = new Map();
    }
  }

  private async saveFacts(): Promise<void> {
    await this.ensureDir();
    const obj = Object.fromEntries(this.facts);
    await writeFile(this.factsPath, JSON.stringify(obj, null, 2), 'utf-8');
  }

  async setFact(key: string, value: string): Promise<void> {
    await this.loadFacts();
    this.facts.set(key, value);
    await this.saveFacts();
  }

  async getFact(key: string): Promise<string | null> {
    await this.loadFacts();
    return this.facts.get(key) ?? null;
  }

  async listFacts(): Promise<Array<{ key: string; value: string }>> {
    await this.loadFacts();
    return Array.from(this.facts.entries()).map(([key, value]) => ({ key, value }));
  }

  async deleteFact(key: string): Promise<void> {
    await this.loadFacts();
    this.facts.delete(key);
    await this.saveFacts();
  }

  async index(_id: string, _content: string, _metadata?: Record<string, unknown>): Promise<void> {
    // Simple implementation: just store facts
    // Vector indexing would go here for full RAG
  }

  async search(query: string, _topK: number = 5): Promise<Array<{ content: string; score: number }>> {
    await this.loadFacts();
    const results: Array<{ content: string; score: number }> = [];
    const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);

    for (const [key, value] of this.facts.entries()) {
      const combined = `${key} ${value}`.toLowerCase();
      let matches = 0;
      for (const word of queryWords) {
        if (combined.includes(word)) matches++;
      }
      if (matches > 0) {
        results.push({
          content: `${key}: ${value}`,
          score: matches / queryWords.length,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  async buildContext(query: string): Promise<string | null> {
    const facts = await this.listFacts();
    if (facts.length === 0) return null;

    const results = await this.search(query);
    if (results.length === 0) return null;

    return '[MEMORY]\n' +
      results.map(r => `- ${r.content}`).join('\n') +
      '\n[/MEMORY]';
  }
}