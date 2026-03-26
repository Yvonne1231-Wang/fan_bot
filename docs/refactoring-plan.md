# fan_bot 改造计划

> 基于代码审查的针对性改造方案 · v1.0 · 2026 Q1

---

## 代码审查结论

**整体判断：基础很好，可以直接在上面加能力。**

分层清晰（transport / agent / session / llm），接口设计干净，刻意不引入框架的决定是对的。
下面列出的是实际读代码发现的问题，而不是通用建议。

### 现存 Bug（需要先修）

| # | 位置 | 问题 |
|---|------|------|
| B1 | `session/store.ts` | `load()` 里 `stats` 对象是假的，`birthtimeMs` 和 `mtimeMs` 永远是 `Date.now()`，不是真实文件时间 |
| B2 | `index.ts` | `sessionManager.prune()` 存在但从未被调用，消息会无限增长直到超出 context window |
| B3 | `utils/debug.ts` | `isEnabled(namespace)` 在模块加载时只运行一次，运行时改 `DEBUG` 环境变量无效 |

### 缺失的核心能力

1. **没有 system prompt**：LLM 不知道自己是谁、能做什么。`chat()` 调用没有传 system。
2. **工具只有 calculator**：没有文件读写、没有搜索，实际没法完成任何真实任务。
3. **HTTP transport 是空壳**：`startHTTP()` 只打了两行 log，不做任何事。
4. **没有流式输出**：用户要等 LLM 生成完才能看到回复，体验差。
5. **没有重试逻辑**：LLM API 一旦返回 429/5xx，直接崩。
6. **CLI 没有 slash 命令**：无法查看历史 session、切换会话等。

---

## 改造路线

```
Phase 1（W1–W2）：修 bug + 让 agent 真正能用
Phase 2（W3–W4）：加实用工具 + 流式输出 + 错误恢复
Phase 3（W5–W8）：Memory / RAG + Planner + Tool 权限体系
```

---

## Phase 1：让 agent 真正能用（W1–W2）

**目标**：修掉现有 bug，补上最基础的缺失能力，让 agent 能做真实的事。

---

### 1.1 修复 JSONLStore 的假 stats（B1）

**问题位置**：`src/session/store.ts` 第 80–83 行

```ts
// 当前：读了两次文件，stats 是假的
const stats = await readFile(filePath).then(() => ({
  birthtimeMs: Date.now(),   // ← 永远是当前时间，不是文件时间
  mtimeMs: Date.now()
}));
```

**修复方案**：

```ts
import { stat } from 'fs/promises';

// 修复后：用 stat() 拿真实文件时间
const [, fileStats] = await Promise.all([
  readFile(filePath, 'utf-8'),
  stat(filePath),
]);

return {
  meta: {
    id,
    createdAt: fileStats.birthtimeMs,
    updatedAt: fileStats.mtimeMs,
    messageCount: messages.length,
  },
  messages,
};
```

**验收条件**：

- [ ] `session.meta.updatedAt` 与文件系统的修改时间一致
- [ ] `list()` 返回的会话按真实修改时间排序

---

### 1.2 在每次对话后调用 prune()（B2）

**问题位置**：`src/index.ts` 的 `handler` 函数

```ts
// 当前：save 前没有 prune
await sessionManager.save(sid, result.messages);
```

**修复方案**：

```ts
// 修复后：save 前先 prune
const pruned = sessionManager.prune(result.messages);
await sessionManager.save(sid, pruned);
```

同时补上被 prune 时的日志提示：

```ts
// session/manager.ts prune() 方法中
if (messages.length > this.maxContextMessages) {
  const dropped = messages.length - this.maxContextMessages;
  console.log(`[session] Context pruned: dropped ${dropped} oldest messages`);
}
```

**验收条件**：

- [ ] 超过 40 条消息的会话，加载时自动剪裁
- [ ] prune 时打印日志，用户知道发生了什么

---

### 1.3 修复 debug logger 的静态 isEnabled（B3）

**问题位置**：`src/utils/debug.ts`

```ts
// 当前：模块加载时只判断一次
export function createDebug(namespace: string): DebugLogger {
  const enabled = isEnabled(namespace);  // ← 这里固定了
  ...
}
```

**修复方案**：

```ts
// 修复后：每次 log 时动态判断
function isEnabledNow(namespace: string): boolean {
  const debugEnv = process.env.DEBUG || '';
  if (!debugEnv) return false;
  // ... 同原有逻辑
}

// log() 内部改为
function log(level: LogLevel, message: string, ...args: unknown[]): void {
  if (!isEnabledNow(namespace)) return;  // ← 每次调用时判断
  // ...
}
```

**验收条件**：

- [ ] 运行中执行 `export DEBUG=agent:loop` 后，日志立即生效

---

### 1.4 给 LLM 加 system prompt

**问题**：`LLMClient.chat()` 接口和 `anthropic.ts`、`openai.ts` 实现都没有 system prompt 参数，agent 没有任何角色定义。

**修改 `src/llm/types.ts`**：

```ts
export interface LLMClient {
  chat(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,   // ← 新增可选参数
  ): Promise<LLMResponse>;
}
```

**修改 `src/llm/anthropic.ts`**（实现层）：

```ts
async chat(
  messages: Message[],
  tools: ToolSchema[] = [],
  systemPrompt?: string,
): Promise<LLMResponse> {
  const response = await this.client.messages.create({
    model: this.model,
    max_tokens: 8096,
    system: systemPrompt,   // ← 传给 API
    messages: toAnthropicMessages(messages),
    tools: tools.length > 0 ? toAnthropicTools(tools) : undefined,
  });
  // ...
}
```

**新建 `src/agent/prompt.ts`**（system prompt 管理）：

```ts
/**
 * Build the system prompt for the agent.
 * Keep it focused: who the agent is, what it can do, how it should behave.
 */
export function buildSystemPrompt(options: {
  agentName?: string;
  extraContext?: string;
} = {}): string {
  const { agentName = 'Assistant', extraContext } = options;

  const base = `You are ${agentName}, a helpful AI assistant with access to tools.

When given a task:
1. Think through what needs to be done
2. Use tools when they would help (don't use tools for things you can answer directly)
3. Be concise and clear in your responses

Available tools will be described separately. Always prefer completing tasks over asking clarifying questions unless the task is genuinely ambiguous.`;

  return extraContext ? `${base}\n\n${extraContext}` : base;
}
```

**在 `src/index.ts` 中传入 system prompt**：

```ts
const result = await runAgent({
  prompt: input,
  llmClient,
  toolRegistry: registry,
  initialMessages: messages,
  maxIterations: 10,
  systemPrompt: buildSystemPrompt({ agentName: 'fan_bot' }),  // ← 新增
});
```

**验收条件**：

- [ ] LLM 回复时有明确的角色定位，不会说"作为 AI 语言模型……"
- [ ] system prompt 可以通过 `buildSystemPrompt` 参数定制

---

### 1.5 补充 CLI slash 命令

当前 CLI 只能输入消息，没有任何管理命令。

**在 `src/transport/cli.ts` 中加入 slash 命令处理**：

```ts
// 在 handler 调用前拦截 slash 命令
if (input.startsWith('/')) {
  await handleSlashCommand(input, { sessionManager, sid });
  rl.prompt();
  return;
}
```

**支持的命令**：

| 命令 | 功能 |
|------|------|
| `/help` | 显示可用命令列表 |
| `/sessions` | 列出最近 10 个会话 |
| `/new` | 开始新会话 |
| `/clear` | 清空当前会话消息 |
| `/status` | 显示当前会话信息（ID、消息数、token 估算） |
| `/exit` | 退出（同 exit） |

**验收条件**：

- [ ] `/sessions` 显示会话列表，按时间倒序
- [ ] `/status` 显示当前消息数量
- [ ] 未知 `/xxx` 命令给出友好提示而非报错

---

### Phase 1 交付物

| 交付物 | 验收标准 |
|--------|---------|
| B1 修复：真实文件时间 | `list()` 按真实时间排序 |
| B2 修复：prune 被调用 | 50 轮对话不超出 context |
| B3 修复：动态 debug 判断 | 运行时改 DEBUG 变量生效 |
| System prompt 支持 | LLM 有明确角色定位 |
| CLI slash 命令 | `/sessions` `/status` 可用 |

---

## Phase 2：实用工具 + 稳定性（W3–W4）

**目标**：让 agent 能真正干活，加上流式输出和错误恢复。

---

### 2.1 补充实用工具

只有 `calculator` 的 agent 什么都做不了。按实用性优先顺序补充：

#### 文件工具（`src/tools/files.ts`）

```ts
export const readFileTool: Tool = {
  schema: {
    name: 'read_file',
    description: 'Read the contents of a file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
    },
  },
  handler: async ({ path }) => {
    const { readFile } = await import('fs/promises');
    const content = await readFile(String(path), 'utf-8');
    // 截断过长输出，避免撑爆 context
    if (content.length > 20000) {
      return content.slice(0, 20000) + '\n\n[... truncated, file too large ...]';
    }
    return content;
  },
};

export const writeFileTool: Tool = { /* 类似结构 */ };
export const listDirTool: Tool = { /* ls 实现 */ };
```

#### Shell 工具（`src/tools/shell.ts`）

```ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const shellTool: Tool = {
  schema: {
    name: 'shell',
    description: 'Run a shell command and return stdout + stderr',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
      },
      required: ['command'],
    },
  },
  handler: async ({ command, timeout = 30000 }) => {
    try {
      const { stdout, stderr } = await execAsync(String(command), {
        timeout: Number(timeout),
        maxBuffer: 1024 * 1024 * 5,  // 5MB
      });
      const output = [stdout, stderr].filter(Boolean).join('\n');
      return output || '(no output)';
    } catch (error: any) {
      return `Exit ${error.code ?? 1}: ${error.stderr || error.message}`;
    }
  },
};
```

#### Web 搜索工具（`src/tools/search.ts`，可选）

```ts
// 依赖 TAVILY_API_KEY 环境变量
// 如果没有 key，工具注册时跳过，不影响其他功能
export const searchTool: Tool = {
  schema: {
    name: 'web_search',
    description: 'Search the web for current information',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  handler: async ({ query }) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error('TAVILY_API_KEY not set');
    // 调用 Tavily API ...
  },
};
```

**在 `src/index.ts` 中注册**：

```ts
registerTool(calculatorTool);
registerTool(readFileTool);
registerTool(writeFileTool);
registerTool(listDirTool);
registerTool(shellTool);

// 可选工具：有 key 才注册
if (process.env.TAVILY_API_KEY) {
  registerTool(searchTool);
}
```

**验收条件**：

- [ ] agent 可以读取并描述项目中的某个文件内容
- [ ] agent 可以执行 `ls` 并告知目录结构
- [ ] 工具输出超过 20000 字符时自动截断

---

### 2.2 流式输出

当前 `chat()` 是阻塞式的，用户等待 LLM 生成完才看到回复。

**在 `src/llm/types.ts` 中扩展接口**：

```ts
export interface LLMClient {
  chat(messages: Message[], tools?: ToolSchema[], system?: string): Promise<LLMResponse>;

  // 新增：流式版本（可选实现）
  stream?(
    messages: Message[],
    tools: ToolSchema[],
    system: string | undefined,
    onChunk: (text: string) => void,
  ): Promise<LLMResponse>;
}
```

**在 `src/agent/loop.ts` 中优先使用流式**：

```ts
// runAgent 新增 onText 回调
export interface RunAgentOptions {
  // ...已有字段
  onText?: (delta: string) => void;  // ← 新增
  systemPrompt?: string;             // ← 新增
}

// loop 内部
const response = llmClient.stream
  ? await llmClient.stream(messages, toolSchemas, options.systemPrompt, options.onText ?? (() => {}))
  : await llmClient.chat(messages, toolSchemas, options.systemPrompt);
```

**CLI 层传入 onText**：

```ts
const result = await runAgent({
  // ...
  onText: (delta) => process.stdout.write(delta),  // 字符级流式输出
});
// 流式完成后换行
console.log('');
```

**验收条件**：

- [ ] CLI 模式下 LLM 输出逐字符实时显示
- [ ] 流式和非流式最终结果一致
- [ ] 工具调用期间不流式（等待工具执行完再继续）

---

### 2.3 错误恢复：指数退避重试

当前 LLM 调用失败直接 throw，没有任何重试。

**在 `src/agent/loop.ts` 中加入重试逻辑**：

```ts
// 新增工具函数
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const { maxRetries = 3 } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isRetryable(lastError)) throw lastError;
      if (attempt === maxRetries - 1) break;

      const delayMs = Math.min(1000 * Math.pow(2, attempt), 30000);  // 1s, 2s, 4s... 最大 30s
      console.warn(`[agent] LLM call failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function isRetryable(error: Error): boolean {
  const msg = error.message.toLowerCase();
  // 429 rate limit、5xx server error 可重试
  return msg.includes('429') || msg.includes('rate limit') ||
    msg.includes('500') || msg.includes('502') || msg.includes('503');
}

// loop 内调用
const response = await withRetry(() =>
  llmClient.chat(messages, toolSchemas, systemPrompt)
);
```

**验收条件**：

- [ ] 模拟 429 响应，agent 自动重试 3 次并打印等待日志
- [ ] 非可重试错误（如 401 invalid API key）立即失败，不重试

---

### 2.4 补全 HTTP transport

当前 `startHTTP()` 是空壳。Fastify 已经在 `package.json` 的 dependencies 里了，直接用。

**`src/transport/http.ts` 实现**：

```ts
import Fastify from 'fastify';

export async function startHTTP(options: HTTPTransportOptions = {}): Promise<void> {
  const { port = 3000, host = '0.0.0.0' } = options;

  const app = Fastify({ logger: false });

  // POST /chat
  app.post<{ Body: ChatRequest }>('/chat', async (req, reply) => {
    const { sessionId, message } = req.body;
    // 调用 agent，返回结果
    // chatHandler 由外部注入（类似 CLI 的 InputHandler）
    const response = await options.chatHandler?.(req.body);
    return reply.send({ sessionId, response, timestamp: Date.now() });
  });

  // GET /sessions
  app.get('/sessions', async (_req, reply) => {
    const sessions = await options.sessionListHandler?.();
    return reply.send({ sessions: sessions ?? [] });
  });

  // GET /health
  app.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok', timestamp: Date.now() });
  });

  await app.listen({ port, host });
  console.log(`HTTP server listening on ${host}:${port}`);
}
```

**验收条件**：

- [ ] `TRANSPORT=http pnpm http` 启动后，`curl POST /chat` 返回正确响应
- [ ] `GET /health` 返回 `{ status: 'ok' }`
- [ ] `GET /sessions` 返回当前会话列表

---

### Phase 2 交付物

| 交付物 | 验收标准 |
|--------|---------|
| 文件工具（read/write/ls） | agent 能读项目文件并描述 |
| Shell 工具 | agent 能执行命令查看结果 |
| 流式输出 | CLI 逐字符实时显示 |
| 指数退避重试 | 429 自动重试 3 次 |
| HTTP transport | POST /chat 可用 |

---

## Phase 3：Memory / RAG + Planner（W5–W8）

**目标**：让 agent 拥有跨会话记忆，并能处理复杂的多步骤任务。

---

### 3.1 Memory 层

**为什么需要**：当前每次对话结束，agent 忘掉一切。用户的偏好、项目结构、历史结论都要重复告知。

**三级记忆设计**（和之前通用 plan 一致，但针对这个项目的实现）：

```
短期记忆  → 已有 session store（保持不变）
工作记忆  → 新增 src/memory/facts.ts（SQLite JSON1 或简单 JSON 文件）
语义记忆  → 新增 src/memory/semantic.ts（LanceDB 向量检索）
```

**接口定义 `src/memory/types.ts`**：

```ts
export interface MemoryService {
  // 工作记忆：明确事实
  setFact(key: string, value: string): Promise<void>;
  getFact(key: string): Promise<string | null>;
  listFacts(): Promise<Array<{ key: string; value: string }>>;
  deleteFact(key: string): Promise<void>;

  // 语义检索
  index(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  search(query: string, topK?: number): Promise<Array<{ content: string; score: number }>>;

  // 构建注入 context（供 system prompt 使用）
  buildContext(query: string): Promise<string | null>;
}
```

**简单实现（Phase 3 早期，无向量库依赖）**：

用 JSON 文件存 facts，关键词匹配做"语义"搜索。等需要真正的语义检索时再换 LanceDB，接口不变。

```ts
// src/memory/json-memory.ts
export class JsonMemoryService implements MemoryService {
  private factsPath: string;

  async setFact(key: string, value: string): Promise<void> {
    const facts = await this.loadFacts();
    facts[key] = value;
    await this.saveFacts(facts);
  }

  async buildContext(query: string): Promise<string | null> {
    const facts = await this.loadFacts();
    const entries = Object.entries(facts);
    if (entries.length === 0) return null;

    // 简单关键词过滤
    const relevant = entries.filter(([k, v]) =>
      query.split(' ').some(word =>
        k.toLowerCase().includes(word.toLowerCase()) ||
        v.toLowerCase().includes(word.toLowerCase())
      )
    );

    if (relevant.length === 0) return null;

    return '[MEMORY]\n' +
      relevant.map(([k, v]) => `- ${k}: ${v}`).join('\n') +
      '\n[/MEMORY]';
  }

  // ...load/save helpers
}
```

**集成到 agent loop**：

在 `buildSystemPrompt` 中注入 memory context：

```ts
// src/agent/prompt.ts
export async function buildSystemPrompt(options: {
  memory?: MemoryService;
  userQuery?: string;
  extraContext?: string;
} = {}): Promise<string> {
  const base = `...`; // 同 Phase 1

  let memoryContext = '';
  if (options.memory && options.userQuery) {
    const ctx = await options.memory.buildContext(options.userQuery);
    if (ctx) memoryContext = `\n\n${ctx}`;
  }

  return base + memoryContext + (options.extraContext ? `\n\n${options.extraContext}` : '');
}
```

**CLI 命令支持**：

```
/remember <key> = <value>   存入工作记忆
/forget <key>               删除指定记忆
/memory                     列出所有工作记忆
```

**升级到真正向量检索（可选，当 JSON 关键词搜索不够用时）**：

```ts
// 安装：pnpm add vectordb  (LanceDB)
// 替换 JsonMemoryService 实现，接口完全不变
import * as lancedb from 'vectordb';
```

**验收条件**：

- [ ] `/remember 项目语言 = TypeScript` 存入后，下次对话自动注入到 system prompt
- [ ] `/memory` 显示所有记忆条目
- [ ] `/forget` 删除指定条目
- [ ] memory context 注入后 LLM 明显引用了相关信息

---

### 3.2 Tool Registry 升级：加权限声明

当前 Registry 没有任何权限控制，所有工具对所有调用者开放。

**扩展 `src/tools/types.ts`**：

```ts
export interface Tool {
  schema: ToolSchema;
  handler: (input: Record<string, unknown>) => Promise<string>;

  // 新增：权限声明
  riskLevel?: 'low' | 'medium' | 'high';
  requiresConfirmation?: boolean;  // 执行前需要用户确认
  description?: string;            // 内部说明，不发给 LLM
}
```

**更新 Registry 支持权限过滤**：

```ts
class Registry implements IToolRegistry {
  // 新增：获取高风险工具列表
  getHighRiskTools(): Tool[] {
    return Array.from(this.tools.values())
      .filter(t => t.riskLevel === 'high');
  }

  // 修改 dispatch：高风险工具执行前请求确认
  async dispatch(
    name: string,
    input: Record<string, unknown>,
    confirmFn?: (preview: string) => Promise<boolean>,  // ← 新增
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool '${name}' not found`);

    if (tool.requiresConfirmation && confirmFn) {
      const preview = `${name}(${JSON.stringify(input)})`;
      const approved = await confirmFn(preview);
      if (!approved) return 'Tool execution cancelled by user.';
    }

    try {
      return await tool.handler(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Tool '${name}' failed: ${message}`);
    }
  }
}
```

**工具注册时声明风险**：

```ts
export const shellTool: Tool = {
  schema: { /* ... */ },
  riskLevel: 'high',
  requiresConfirmation: true,  // shell 执行前需确认
  handler: async ({ command }) => { /* ... */ },
};

export const readFileTool: Tool = {
  schema: { /* ... */ },
  riskLevel: 'low',  // 只读，不需要确认
  handler: async ({ path }) => { /* ... */ },
};
```

**CLI 确认提示**：

```ts
const confirmFn = async (preview: string): Promise<boolean> => {
  return new Promise(resolve => {
    rl.question(`\n[confirm] ${preview}\nProceed? [y/N] `, answer => {
      resolve(answer.toLowerCase() === 'y');
    });
  });
};
```

**验收条件**：

- [ ] `shell` 工具执行前 CLI 显示确认提示
- [ ] 用户输入 `n` 时，工具不执行，LLM 收到取消通知
- [ ] `read_file` 不触发确认

---

### 3.3 Planner

**为什么需要**：面对"帮我重构这个模块"这类复杂任务，当前 agent 会一口气乱改，没有计划。Planner 先拆分任务，再逐步执行。

**触发条件**（简单启发式，不用 LLM 判断）：

```ts
function shouldPlan(message: string): boolean {
  if (message.startsWith('/plan ')) return true;
  if (message.length > 200) return true;
  const multiStepWords = ['先', '然后', '最后', '再', 'then', 'after', 'finally', 'step'];
  return multiStepWords.some(w => message.toLowerCase().includes(w));
}
```

**Plan 数据结构**：

```ts
interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  status: 'pending' | 'running' | 'done';
}

interface PlanStep {
  index: number;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;
}
```

**Planner 实现**（`src/agent/planner.ts`）：

```ts
export async function createPlan(
  goal: string,
  llmClient: LLMClient,
  systemPrompt: string,
): Promise<Plan> {
  // 用 LLM 把 goal 分解成步骤列表
  const response = await llmClient.chat(
    [{
      role: 'user',
      content: [{
        type: 'text',
        text: `Break this task into clear numbered steps. Return ONLY a JSON array of step titles.
Task: ${goal}`,
      }],
    }],
    [],  // 不用工具
    `You are a task planning assistant. Return ONLY valid JSON arrays like ["Step 1", "Step 2"].`,
  );

  const text = response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text).join('');

  // 解析步骤
  const stepTitles: string[] = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? '[]');

  return {
    id: `plan-${Date.now()}`,
    goal,
    steps: stepTitles.map((title, i) => ({
      index: i,
      title,
      status: 'pending',
    })),
    status: 'pending',
  };
}
```

**在 loop 中集成 Planner**：

```ts
// index.ts handler
if (shouldPlan(input)) {
  const plan = await createPlan(input, llmClient, systemPrompt);

  // 展示计划给用户确认
  console.log('\n[Planner] Task breakdown:');
  plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.title}`));

  const confirmed = await askConfirmation('Execute this plan? [y/N] ');
  if (!confirmed) {
    console.log('Plan cancelled.');
    return 'Okay, cancelled.';
  }

  // 逐步执行
  let lastResult = '';
  for (const step of plan.steps) {
    console.log(`\n[Step ${step.index + 1}/${plan.steps.length}] ${step.title}`);
    step.status = 'running';

    const result = await runAgent({
      prompt: `${step.title}\n\nContext from previous steps:\n${lastResult}`,
      llmClient,
      toolRegistry: registry,
      initialMessages: await sessionManager.load(sid),
      maxIterations: 10,
      systemPrompt,
    });

    step.status = 'done';
    step.result = result.response;
    lastResult = result.response;
    await sessionManager.save(sid, result.messages);
  }

  return `Plan complete.\n\nFinal result:\n${lastResult}`;
}
```

**验收条件**：

- [ ] `/plan 帮我给这个项目加上 ESLint 配置` 生成分步计划
- [ ] 用户确认后，agent 逐步执行每个 step 并显示进度
- [ ] 用户拒绝执行时，计划取消，不执行任何操作
- [ ] 每个 step 的上下文（前一 step 的结果）传递给下一 step

---

### Phase 3 交付物

| 交付物 | 验收标准 |
|--------|---------|
| Memory（工作记忆） | `/remember` `/forget` `/memory` 可用 |
| Memory 注入 system prompt | LLM 引用存储的事实 |
| Tool 权限声明 | shell 工具执行前弹确认 |
| Planner | `/plan` 分解任务并逐步执行 |

---

## 完整文件改动清单

```
src/
├── agent/
│   ├── loop.ts          修改：加 systemPrompt 参数、withRetry、onText 流式回调
│   ├── prompt.ts        新增：buildSystemPrompt()，支持 memory 注入
│   └── planner.ts       新增：createPlan()，步骤分解与执行
├── llm/
│   ├── types.ts         修改：LLMClient.chat() 加 systemPrompt 参数，新增 stream()
│   ├── anthropic.ts     修改：实现 systemPrompt 传递和流式输出
│   └── openai.ts        修改：同上
├── memory/
│   ├── types.ts         新增：MemoryService 接口
│   └── json-memory.ts   新增：基于 JSON 文件的简单实现
├── session/
│   ├── store.ts         修复 B1：用 stat() 获取真实文件时间
│   └── manager.ts       修复 B2：prune 时打印日志
├── tools/
│   ├── types.ts         修改：Tool 加 riskLevel 和 requiresConfirmation
│   ├── registry.ts      修改：dispatch 加 confirmFn 参数
│   ├── files.ts         新增：read_file / write_file / list_dir
│   └── shell.ts         新增：shell 工具
├── transport/
│   ├── cli.ts           修改：加 slash 命令处理、确认提示、流式输出
│   └── http.ts          修改：用 Fastify 实现真正的 HTTP server
├── utils/
│   └── debug.ts         修复 B3：isEnabled 改为动态判断
└── index.ts             修改：注册新工具、传 systemPrompt、调用 prune
```

---

*fan_bot Refactoring Plan · v1.0*