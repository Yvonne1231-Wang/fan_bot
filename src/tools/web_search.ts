// ─── Web Search Tool ────────────────────────────────────────────────────────

import { tavily } from '@tavily/core';
import type { Tool } from './types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('tools:web_search');

/**
 * Web search tool using Tavily API.
 * Provides real-time web search capabilities for the agent.
 */
export const webSearchTool: Tool = {
  schema: {
    name: 'web_search',
    description:
      'Search the web for real-time information. Returns relevant search results with titles, URLs, and content snippets.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query string',
        },
        search_depth: {
          type: 'string',
          enum: ['basic', 'advanced'],
          description:
            'Search depth: "basic" for quick results, "advanced" for more comprehensive results (default: basic)',
        },
        max_results: {
          type: 'number',
          description:
            'Maximum number of results to return (default: 5, max: 10)',
        },
        include_domains: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of domains to specifically include in the search (optional)',
        },
        exclude_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of domains to exclude from the search (optional)',
        },
      },
      required: ['query'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
      throw new Error(
        'TAVILY_API_KEY is not configured. Please set it in your environment variables.',
      );
    }

    const query = String(input.query);
    const searchDepth = (input.search_depth as 'basic' | 'advanced') || 'basic';
    const maxResults = Math.min(Number(input.max_results) || 5, 10);
    const includeDomains = input.include_domains as string[] | undefined;
    const excludeDomains = input.exclude_domains as string[] | undefined;

    log.debug(`Searching for: ${query}`);

    try {
      const client = tavily({ apiKey });

      const response = await client.search(query, {
        searchDepth,
        maxResults,
        includeDomains,
        excludeDomains,
      });

      if (!response.results || response.results.length === 0) {
        return 'No results found for your query.';
      }

      const formattedResults = response.results
        .map((result: { title?: string; url?: string; content?: string }, index: number) => {
          return `[${index + 1}] ${result.title ?? 'Untitled'}\nURL: ${result.url ?? 'N/A'}\n${result.content ?? ''}\n`;
        })
        .join('\n---\n\n');

      return `Found ${response.results.length} results:\n\n${formattedResults}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Search failed: ${message}`);
      throw new Error(`Web search failed: ${message}`);
    }
  },
};
