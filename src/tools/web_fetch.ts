// ─── Web Fetch Tool ─────────────────────────────────────────────────────────
// 混合抓取策略：优先使用本地 link_analyze（免费），失败时降级到 Tavily API

import { tavily } from '@tavily/core';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Tool } from './types.js';
import { createDebug } from '../utils/debug.js';

const log = createDebug('tools:web_fetch');

// ============================================================
// 配置
// ============================================================
const DEFAULT_TIMEOUT = 30_000;
const MAX_REDIRECTS = 10;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_FETCH_OUTPUT_CHARS = 30000;

// ============================================================
// 类型定义
// ============================================================

interface FetchResult {
  source: 'link_analyze' | 'tavily';
  content: string;
  url: string;
  confidence: number; // 内容质量置信度 0-1
}

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  finalUrl: string;
  redirectChain: string[];
}

interface PageMeta {
  title: string;
  description: string;
}

// ============================================================
// HTTP 请求层 —— 纯 Node.js 内置模块
// ============================================================

function httpGet(
  url: string,
  timeout = DEFAULT_TIMEOUT,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const redirectChain: string[] = [url];
    let currentUrl = url;
    let redirectCount = 0;

    function doRequest() {
      const parsedUrl = new URL(currentUrl);
      const mod = parsedUrl.protocol === 'https:' ? https : http;

      const req = mod.get(
        currentUrl,
        {
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'identity',
          },
          timeout,
        },
        (res) => {
          // 处理重定向
          if (
            res.statusCode &&
            [301, 302, 303, 307, 308].includes(res.statusCode)
          ) {
            const location = res.headers.location;
            if (!location) {
              reject(new Error('Redirect without Location header'));
              return;
            }
            if (++redirectCount > MAX_REDIRECTS) {
              reject(new Error(`Too many redirects (>${MAX_REDIRECTS})`));
              return;
            }
            currentUrl = new URL(location, currentUrl).href;
            redirectChain.push(currentUrl);
            res.resume();
            doRequest();
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers as Record<
                string,
                string | string[] | undefined
              >,
              body: Buffer.concat(chunks).toString('utf-8'),
              finalUrl: currentUrl,
              redirectChain,
            });
          });
          res.on('error', reject);
        },
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout after ${timeout}ms`));
      });
      req.on('error', reject);
    }

    doRequest();
  });
}

// ============================================================
// HTML 简单清洗（轻量级，不依赖外部库）
// ============================================================

function simpleHtmlClean(html: string): string {
  // 移除 script/style 标签及其内容
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // 移除其他无关标签但保留内容
  cleaned = cleaned.replace(
    /<\/?(?:nav|footer|header|aside|iframe|svg|canvas|video|audio)[^>]*>/gi,
    '',
  );

  // 提取 body 内容
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return bodyMatch ? bodyMatch[1].trim() : cleaned.trim();
}

function extractMetaSimple(html: string): PageMeta {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const descMatch =
    html.match(
      /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)/i,
    ) ||
    html.match(
      /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i,
    );

  return {
    title: titleMatch?.[1]?.trim() || '',
    description: descMatch?.[1]?.trim() || '',
  };
}

// ============================================================
// Hybrid Web Fetcher —— 混合抓取器
// ============================================================

class HybridWebFetcher {
  private tavilyApiKey: string | undefined;

  constructor(tavilyApiKey?: string) {
    this.tavilyApiKey = tavilyApiKey;
  }

  async fetch(url: string): Promise<FetchResult> {
    // Step 1: 优先使用本地 link_analyze（免费）
    try {
      const result = await this.tryLinkAnalyze(url);
      if (result.textLength > 300) {
        log.debug(
          `Link analyze succeeded for ${url}, content length: ${result.textLength}`,
        );
        return {
          source: 'link_analyze',
          content: result.content,
          url: result.finalUrl,
          confidence: result.method === 'readability' ? 0.9 : 0.7,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Link analyze failed for ${url}: ${message}`);
    }

    // Step 2: 降级到 Tavily（需要 API Key）
    if (this.tavilyApiKey) {
      try {
        const result = await this.tryTavily(url);
        log.debug(`Tavily extract succeeded for ${url}`);
        return {
          source: 'tavily',
          content: result.content,
          url: result.url,
          confidence: 0.85,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`Tavily extract failed for ${url}: ${message}`);
      }
    }

    throw new Error(`Failed to fetch content from ${url}: all methods failed`);
  }

  private async tryLinkAnalyze(url: string): Promise<{
    content: string;
    textLength: number;
    finalUrl: string;
    method: 'readability' | 'fallback';
  }> {
    const response = await httpGet(url);
    const contentType = String(response.headers['content-type'] || '');

    // 非 HTML：直接返回原文
    if (!contentType.includes('html')) {
      const body = response.body.slice(0, MAX_FETCH_OUTPUT_CHARS);
      return {
        content: body,
        textLength: body.length,
        finalUrl: response.finalUrl,
        method: 'fallback',
      };
    }

    // HTML：清洗并提取内容
    const cleaned = simpleHtmlClean(response.body);
    const meta = extractMetaSimple(response.body);

    // 构造简单的 Markdown 输出
    let content = '';
    if (meta.title) {
      content += `# ${meta.title}\n\n`;
    }
    if (meta.description) {
      content += `> ${meta.description}\n\n`;
    }
    content += cleaned;

    // 移除多余空白
    content = content.replace(/\n{3,}/g, '\n\n').trim();

    return {
      content,
      textLength: content.length,
      finalUrl: response.finalUrl,
      method: 'readability', // 简化处理，统一标记为 readability
    };
  }

  private async tryTavily(
    url: string,
  ): Promise<{ content: string; url: string }> {
    const client = tavily({ apiKey: this.tavilyApiKey! });

    const response = await client.extract([url], {
      includeImages: false,
    });

    if (!response.results || response.results.length === 0) {
      throw new Error('No content extracted from URL');
    }

    const result = response.results[0];

    if (!result.rawContent || result.rawContent.trim().length === 0) {
      throw new Error('Extracted content is empty');
    }

    return {
      content: result.rawContent,
      url: result.url || url,
    };
  }
}

// ============================================================
// Web Fetch Tool —— 导出给 Agent 使用的 Tool
// ============================================================

export const webFetchTool: Tool = {
  schema: {
    name: 'web_fetch',
    description:
      'Fetch and extract content from specific URLs. Uses a hybrid strategy: tries local extraction first (fast & free), falls back to Tavily API if needed. Returns the extracted text content from the webpage.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to extract content from',
        },
        include_images: {
          type: 'boolean',
          description:
            'Whether to include image descriptions in the extracted content (default: false)',
        },
      },
      required: ['url'],
    },
  },

  handler: async (input: Record<string, unknown>): Promise<string> => {
    const tavilyApiKey = process.env.TAVILY_API_KEY;
    const url = String(input.url);

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error('Invalid URL: must start with http:// or https://');
    }

    log.debug(`Fetching content from: ${url}`);

    const fetcher = new HybridWebFetcher(tavilyApiKey || undefined);

    try {
      const result = await fetcher.fetch(url);

      log.debug(
        `Fetch succeeded via ${result.source}, confidence: ${result.confidence}`,
      );

      let output = `Extracted content from ${result.url} (via ${result.source}):

${result.content}`;

      if (output.length > MAX_FETCH_OUTPUT_CHARS) {
        log.warn(
          `Web fetch output truncated: ${output.length} -> ${MAX_FETCH_OUTPUT_CHARS} chars`,
        );
        output =
          output.slice(0, MAX_FETCH_OUTPUT_CHARS) +
          '\n\n[... content truncated due to size limit ...]';
      }

      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Fetch failed: ${message}`);
      throw new Error(`Web fetch failed: ${message}`);
    }
  },
};
