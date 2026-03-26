# Coding Agent 改造计划

> Architecture Refactoring Roadmap · v1.0 · 2026 Q1

---

## 目录

1. [改造目标与原则](#0-改造目标与原则)
2. [Phase 1：基础稳定性（W1–W4）](#phase-1基础稳定性w1w4)
3. [Phase 2：能力扩展（W5–W8）](#phase-2能力扩展w5w8)
4. [Phase 3：多 Agent 协作（W9–W12）](#phase-3多-agent-协作w9w12)
5. [风险与缓解策略](#风险与缓解策略)
6. [时间线总览](#时间线总览)
7. [附录：关键接口速查](#附录关键接口速查)

---

## 执行规范（agent 必读）

- 每次只处理一个 task，完成后等待确认再继续
- 修改代码前先输出"计划：我将要做 X，影响文件 Y"
- 完成后输出"完成：已修改 X，验收条件 [x] 已满足"
- 遇到歧义不要自行决定，先提问

---

## 0. 改造目标与原则

本计划面向初级 Coding Agent 的系统性升级改造，分 3 个阶段交付，合计约 **12 周**。目标是将一个能跑通基本 loop 的 MVP，改造为具备生产稳定性、安全隔离和多 agent 协作能力的工程级 agent 框架。

### 核心原则

| 原则 | 说明 |
|------|------|
| 最小破坏性 | 每阶段保持向后兼容，优先重构而非重写 |
| 可观测优先 | 每个新特性都必须附带可量化的指标和日志 |
| 安全边界前置 | 权限模型和沙箱在 Phase 1 就要建立，不能留到最后 |
| 渐进式复杂度 | Phase 1 修 bug + 夯基础，Phase 2 加能力，Phase 3 扩展到多 agent |

### 改造前后架构对比

```
改造前                          改造后
──────────────────────          ──────────────────────────────────────
transport                       transport
  └─ CLI / HTTP                   └─ CLI / HTTP

agent core                      agent core
  ├─ Agent loop                   ├─ Agent loop
  ├─ Tool dispatcher              ├─ Planner          ← 新增
  └─ Context mgr                  ├─ Dispatcher
                                  └─ Context mgr      ← 重构

session（串在主流程）            peer dependencies   ← 重新定位
  ├─ Session store                ├─ Session store
  └─ Session manager              ├─ Memory / RAG     ← 新增
                                  └─ Tool Registry    ← 新增

llm adapter（不变）             llm adapter
  ├─ Anthropic                    ├─ Anthropic
  ├─ Ark / OpenAI                 ├─ Ark / OpenAI
  └─ LLMClient                    └─ LLMClient
```

---

## Phase 1：基础稳定性（W1–W4）

修复已知的 critical bug，建立可观测性基础，完成上下文管理和工具权限的正确实现。**这一阶段完成后，agent 应该能稳定跑长对话且不会悄悄丢数据。**

---

### 1.1 修复 Compaction 失效 bug（P0）

**Bug 描述**

`maybeCompactContext` 返回的 `newMessages` 从未写回 `context.messages`，导致压缩实际上是空跑。下一轮循环仍然使用原始未压缩的消息列表，长对话必然 token 溢出后崩溃。

**根本原因定位**

```ts
// loop.ts ~line 194  —— 当前错误实现
const { didCompact, newMessages } = await maybeCompactContext(context, { ... });

if (didCompact) {
  // 只发了事件通知，newMessages 从未被应用
  await emitCompactionEvent(context, options, loopHooks, {
    currentMessages: context.messages,
    newMessages,   // ← 传进去了，但 context.messages 没变
    ...
  });
  continue;       // 下一轮还是读原始 context.messages
}
```

**修复方案**

```ts
if (didCompact && newMessages) {
  context.messages = newMessages;   // ← 补上这一行
  await emitCompactionEvent(context, options, loopHooks, {
    currentMessages: context.messages,
    newMessages,
    trigger: 'pre-loop',
    ...
  });
  continue;
}
```

同理，`finishReason === 'length'` 触发的强制压缩分支需要同样修复。

**验收条件**

- [ ] 单测：模拟 context 超过 `COMPACT_TRIGGER` 阈值，断言 `context.messages.length` 在压缩后减小
- [ ] 集成测试：连续 50 轮对话不崩溃，token 使用量平稳不增长
- [ ] 压缩前后消息数量差异记录到 Observability 日志

---

### 1.2 修复 stop + 空 text 的潜在无限循环（P0）

**Bug 描述**

`MAX_STEPS` 只在 `finishReason === 'tool-calls'` 分支检查。如果 LLM 返回 `stop` 但 `text` 为空，会无限 `continue` 而没有任何终止保护。

**修复方案**

```ts
// 在 while(true) 顶部增加全局步数检查（覆盖所有 finishReason）
if (totalSteps >= MAX_STEPS) {
  return `Max steps (${MAX_STEPS}) reached, task may be incomplete.`;
}

// stop + 空 text 分支增加独立计数器
let emptyStopCount = 0;
const MAX_EMPTY_STOP = 3;

if (finishReason === 'stop' && !text) {
  emptyStopCount++;
  if (emptyStopCount >= MAX_EMPTY_STOP) {
    return 'Loop terminated: repeated empty stop response.';
  }
  continue;
}
```

**验收条件**

- [ ] 单测：mock LLM 持续返回 `{ finishReason: 'stop', text: '' }`，断言循环在 `MAX_EMPTY_STOP` 次后退出
- [ ] 全局 `MAX_STEPS` 检查覆盖所有 `finishReason` 分支

---

### 1.3 Context 类重构

将 `Context` 从纯数据对象升级为有行为的类，让压缩逻辑内聚，同步消灭 `loop.ts` 和 `context/index.ts` 中重复的 `estimateTokens` 实现。

**新接口设计**

```ts
interface IContext {
  readonly sessionId: string;
  readonly messages: ReadonlyArray<ModelMessage>;

  // 追加消息（替代直接 push）
  append(message: ModelMessage): void;

  // 执行压缩并原地更新 messages（修复 1.1 的根本解法）
  compact(opts?: CompactOptions): Promise<CompactResult>;

  // 统一的 token 估算（消除重复实现）
  estimateTokens(): number;

  // 快照 / 恢复（Phase 2 Plan Mode 沙盒执行需要）
  snapshot(): ContextSnapshot;
  restore(snapshot: ContextSnapshot): void;
}
```

**重构要点**

- `context.messages` 改为只读，外部只能通过 `context.append()` 追加
- `compact()` 方法内部调用 `maybeCompactContext` 并自动写回，`loop.ts` 不再关心写回逻辑
- 删除 `loop.ts` 中的 `estimateMessageTokens`，统一使用 `context.estimateTokens()`

**验收条件**

- [ ] `estimateTokens` 只有一处实现
- [ ] 现有所有测试通过（接口兼容）
- [ ] `loop.ts` 不再直接赋值 `context.messages`

---

### 1.4 Tool Registry 建立

把工具的注册、权限声明、metadata 从 `Dispatcher` 剥离，建立独立的 `ToolRegistry`。Dispatcher 只负责"拿到工具定义并执行"，权限判断由 Registry 完成。

**ToolDefinition 扩展**

```ts
interface ToolDefinition<I = any, O = any> {
  // 原有字段
  name: string;
  description: string;
  inputSchema: ZodSchema<I>;
  execute: (input: I, ctx: ExecutionContext) => Promise<O>;

  // 新增：权限与风险声明
  scope: 'global' | 'restricted' | 'agent-only';
  //   global      → 任何 agent 都可以使用
  //   restricted  → 只有主 agent 可以使用
  //   agent-only  → 只能被特定子 agent 使用

  riskLevel: 'low' | 'medium' | 'high';
  requiresConfirmation?: boolean;  // 高风险工具执行前需要用户确认
  allowedRoles?: string[];         // 角色白名单（空 = 全部角色）
  defer_loading?: boolean;
}
```

**ToolRegistry 接口**

```ts
class ToolRegistry {
  register(tool: ToolDefinition): void;

  // 按角色解析工具，null 表示无权限
  resolve(name: string, agentRole?: string): ToolDefinition | null;

  getByScope(scope: ToolDefinition['scope']): ToolDefinition[];
  getByRisk(level: ToolDefinition['riskLevel']): ToolDefinition[];
  list(): ToolDefinition[];
}
```

**内置工具权限声明**

| 工具 | scope | riskLevel | requiresConfirmation |
|------|-------|-----------|----------------------|
| `read` | global | low | false |
| `grep` | global | low | false |
| `ls` | global | low | false |
| `tavily` | global | low | false |
| `write` | restricted | medium | false |
| `edit` | restricted | medium | false |
| `bash` | restricted | high | **true** |

**验收条件**

- [ ] `bash` 工具注册时声明 `scope: 'restricted'`，子 agent 调用返回权限错误
- [ ] `ToolRegistry` 单测：resolve 正确过滤不在 `allowedRoles` 的角色
- [ ] 现有工具注册迁移到 Registry，不改变对外行为

---

### 1.5 Observability 基础层

每次 LLM 调用、工具执行都需要可追踪的结构化记录，不能靠 `console.log` 打散文字。

**事件类型定义**

```ts
type ObservabilityEvent =
  | {
      type: 'llm_call';
      traceId: string;
      model: string;
      promptTokens: number;
      completionTokens: number;
      latencyMs: number;
      firstChunkMs?: number;   // TTFT
      finishReason: string;
    }
  | {
      type: 'tool_call';
      traceId: string;
      toolName: string;
      durationMs: number;
      success: boolean;
      error?: string;
      outputLength: number;
    }
  | {
      type: 'compaction';
      traceId: string;
      beforeMessages: number;
      afterMessages: number;
      beforeTokens: number;
      afterTokens: number;
      strategy: string;
    };
```

**Observer 接口**

```ts
interface IObserver {
  emit(event: ObservabilityEvent): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, err?: Error): void;
}
```

**实现策略**

- 在 `afterLLMCall` hook 中汇总 timing 数据
- `Dispatcher` 的 `afterToolCall` 统一发 span 事件
- 默认实现：异步写 JSONL 文件到 `~/.pulse-coder/traces/`
- 生产环境：换 OpenTelemetry exporter，接口不变

**验收条件**

- [ ] JSONL 日志包含所有关键指标，字段不缺失
- [ ] 单次对话结束后可以从日志中还原完整的 LLM 调用链
- [ ] 日志写入不影响主流程性能（异步写）

---

### 1.6 onToolCall hook 改为可 await（P1）

当前实现是 fire-and-forget，错误被静默吞掉，与 `beforeToolCall` / `afterToolCall` 的同步语义完全不一致。

```ts
// 当前（错误）—— 错误静默丢弃
Promise.resolve(hook({ context, toolCall: chunk })).catch(() => undefined);

// 修复后 —— 顺序 await，错误可被观测
for (const hook of toolCallHooks) {
  try {
    await hook({ context, toolCall: chunk });
  } catch (err) {
    observer.warn('onToolCall hook failed', { err });
    // 不中断主流程，但错误会被记录
  }
}
```

**验收条件**

- [ ] `onToolCall` hook 中抛出的错误可以在 Observability 日志中看到
- [ ] 现有使用 `onToolCall` 的插件行为不变

---

### Phase 1 交付物汇总

| 交付物 | 类型 | 验收标准 |
|--------|------|---------|
| Compaction bug fix + 单测 | bug fix | 50 轮对话无 token 溢出 |
| 无限循环保护 | bug fix | MAX_STEPS 全局生效 |
| Context 类重构 | 重构 | estimateTokens 只有一处实现 |
| ToolRegistry v1 | 新增 | bash 工具按 scope 隔离 |
| ObservabilityLayer v1 | 新增 | JSONL 日志包含所有关键指标 |
| onToolCall 同步化 | bug fix | hook 错误可被观测 |

---

## Phase 2：能力扩展（W5–W8）

在稳定基础上加入 Plan Mode 的硬隔离、SubAgent 工具白名单、Memory 层和 Human-in-the-loop。

---

### 2.1 Plan Mode 硬隔离

当前 Plan Mode 是 prompt-constrained，只靠 system prompt 告诉 LLM 不要调用写操作工具。**改为在 Dispatcher 层做硬拦截。**

**两种模式的工具权限对比**

| 工具类别 | Planning 模式 | Executing 模式 |
|---------|--------------|----------------|
| `read`, `grep`, `ls`, `search` | 允许 | 允许 |
| `bash`（只读命令） | 条件允许 | 允许 |
| `write`, `edit` | **硬拦截** | 允许 |
| `bash`（写/执行操作） | **硬拦截** | 允许（高风险需确认） |

**实现：Dispatcher 的 beforeToolCall hook**

```ts
if (planModeService.getMode() === 'planning') {
  const toolDef = registry.resolve(toolName, agentRole);

  if (!toolDef || toolDef.scope !== 'global') {
    throw new PlanModeViolationError(
      `Tool '${toolName}' is not allowed in planning mode. ` +
      `Switch to executing mode first.`
    );
  }
}
```

- 错误信息返回给 LLM（作为 tool-result），LLM 可以选择切换模式重试
- Violation 事件同步记录到 Observability

**验收条件**

- [ ] Planning 模式下调用 `bash` 返回 `PlanModeViolationError`
- [ ] LLM 收到错误后能正确切换模式，而非死循环
- [ ] Violation 事件记录到 Observability

---

### 2.2 SubAgent 工具隔离

子 agent 当前继承父 agent 的全部工具。改造为子 agent 在定义文件中声明所需工具列表，由 `ToolRegistry` 按 `allowedRoles` 过滤。

**子 agent 定义文件扩展（Markdown frontmatter）**

```markdown
---
name: code-reviewer
description: 专用代码审查助手
allowedTools:
  - read
  - grep
  - ls
# 不声明 = 只有 read 权限（最小权限原则）
---

You are a code reviewer...
```

**SubAgentPlugin 初始化时的工具过滤**

```ts
const allowedTools = config.allowedTools ?? ['read'];

const tools = Object.fromEntries(
  allowedTools
    .map(name => [name, registry.resolve(name, config.name)])
    .filter(([, def]) => def !== null)  // null = 无权限，过滤掉
);

const result = await loop(subContext, {
  tools,          // ← 已经过滤过的工具集
  systemPrompt: config.systemPrompt,
});
```

**预设角色工具权限**

| 角色 | 允许工具 | 说明 |
|------|---------|------|
| researcher | read, grep, ls, tavily | 只读，用于分析和检索 |
| coder | read, write, edit, grep | 可以修改代码，不能执行 |
| executor | read, bash | 可以执行命令，谨慎授权 |
| reviewer | read, grep, ls | 只读，用于审查 |
| documenter | read, write（仅 `.md`） | 限制写权限只到文档文件 |

**验收条件**

- [ ] `code-reviewer` 子 agent 调用 `bash` 时返回权限错误
- [ ] 未声明 `allowedTools` 的子 agent 只能使用 `read`
- [ ] 父 agent 不受子 agent 工具限制影响

---

### 2.3 Memory / RAG 层

Session store 只负责当前对话持久化。**跨会话的长期信息需要独立的 Memory 层。**

#### 三级记忆架构

```
┌─────────────────────────────────────────────────────┐
│  短期记忆（in-session）                               │
│  context.messages，随会话结束而清空                   │
│  压缩前做摘要注入到下一轮                              │
├─────────────────────────────────────────────────────┤
│  工作记忆（cross-session facts）                     │
│  SQLite JSON1，存放明确的事实和结论                   │
│  例："项目使用 pnpm workspace""测试命令是 pnpm test"  │
├─────────────────────────────────────────────────────┤
│  长期记忆（semantic）                                 │
│  向量数据库，存放文档块、代码片段                      │
│  支持语义检索，hybrid search（BM25 + ANN）            │
└─────────────────────────────────────────────────────┘
```

#### 技术选型

| 组件 | 推荐方案 | 备选 |
|------|---------|------|
| 向量存储 | LanceDB（嵌入式，零依赖） | Chroma, Qdrant |
| Embedding | text-embedding-3-small | nomic-embed（本地） |
| 检索策略 | BM25 + ANN hybrid search | 纯向量检索 |
| 事实存储 | SQLite JSON1 | Redis |

#### Memory 接口设计

```ts
interface MemoryService {
  // 工作记忆：结构化事实
  setFact(key: string, value: string, sessionId?: string): Promise<void>;
  getFact(key: string): Promise<string | null>;
  listFacts(prefix?: string): Promise<Array<{ key: string; value: string }>>;

  // 语义记忆：向量检索
  upsert(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  search(query: string, topK?: number, threshold?: number): Promise<MemoryChunk[]>;
  delete(id: string): Promise<void>;

  // 构建注入 prompt（供 beforeLLMCall hook 调用）
  buildContext(query: string): Promise<string | null>;
}

interface MemoryChunk {
  id: string;
  content: string;
  score: number;        // 相关度 0–1，低于 0.70 不注入
  metadata?: Record<string, unknown>;
}
```

#### Memory 写入时机

| 时机 | 触发条件 | 写入目标 |
|------|---------|---------|
| `afterRun` hook | 每次对话结束 | 让 LLM 萃取关键事实 → 工作记忆 |
| `afterToolCall` | bash/read 输出 > 500 字 | 摘要写入语义记忆 |
| 用户显式触发 | `/remember <内容>` | 直接写入工作记忆 |
| 用户显式删除 | `/forget <key>` | 删除指定事实 |

#### Memory 读取（beforeLLMCall hook）

```ts
const memoryContext = await memoryService.buildContext(lastUserMessage);

if (memoryContext) {
  // 注入格式：
  // [MEMORY]
  // - 用户倾向使用 TypeScript strict 模式
  // - 项目根目录：/workspace/aurora
  // [/MEMORY]
  systemPrompt = appendToSystemPrompt(systemPrompt, memoryContext);
}
```

**相关度阈值**：检索结果低于 `0.70` 的不注入，避免引入无关噪声。

**验收条件**

- [ ] `/remember` 命令写入工作记忆，下次会话可以查询到
- [ ] 代码库文件索引后，语义检索 "auth 相关代码" 返回正确文件
- [ ] 低相关度（< 0.70）的内容不注入 system prompt
- [ ] Memory 读写不引入超过 200ms 的延迟

---

### 2.4 Human-in-the-loop

高风险工具执行前需要人工确认，不能让 agent 默默运行可能不可逆的操作。

#### 触发条件

```ts
// Dispatcher beforeToolCall hook
const needsConfirmation =
  toolDef.requiresConfirmation ||      // 工具声明需要确认
  (toolDef.riskLevel === 'high') ||    // 高风险工具
  consecutiveWriteCount >= 3;          // 连续 3 次以上写操作
```

#### 确认请求数据结构

```ts
interface ConfirmationRequest {
  toolName: string;
  riskLevel: 'low' | 'medium' | 'high';
  preview: string;    // 人类可读的操作预览（bash 显示命令，write 显示路径+内容摘要）
  timeout: number;    // 超时后默认拒绝（毫秒）
}
```

#### 各 transport 层实现

**CLI：**
```
[确认] 即将执行高风险操作
工具：bash
命令：rm -rf ./dist && npm run build
风险：high

是否继续？[y/N] _
```

**HTTP：**
```
SSE 事件: { type: 'confirmation_required', requestId, preview }
  ↓ 前端展示确认对话框
POST /confirm { requestId, approved: true/false }
  ↓ 恢复 loop 执行
```

**验收条件**

- [ ] `bash` 工具每次执行前触发确认流程
- [ ] CLI 模式下超时 30s 未确认，默认拒绝并返回错误给 LLM
- [ ] HTTP 模式下前端可以通过 webhook 回调确认

---

### 2.5 Session 层重新定位

Session 从主流程的中间层，改为 agent core 按需读写的 peer 依赖。

**改造要点**

- Session 只在 `beforeRun` 加载历史消息、`afterRun` 保存新消息
- `sessionId` 作为 `Context` 的字段，不再从外部串传
- 新增 `SessionIndex`（SQLite）支持按关键词搜索历史会话
- Session prune 策略：超过 N 条会话后，对最老的自动归档压缩

```ts
// Engine.run() 伪代码
async run(userMessage: string, sessionId?: string): Promise<string> {
  const session = await sessionStore.load(sessionId);
  const context = new Context({ sessionId: session.id, messages: session.messages });
  context.append({ role: 'user', content: userMessage });

  const result = await loop(context, options);

  await sessionStore.save(context.sessionId, context.messages);

  return result;
}
```

**验收条件**

- [ ] Session 不再是 `loop()` 的参数
- [ ] `/resume <sessionId>` 可以正确恢复历史对话
- [ ] `/search "auth bug"` 返回相关历史会话列表

---

### Phase 2 交付物汇总

| 交付物 | 类型 | 验收标准 |
|--------|------|---------|
| Plan Mode 硬拦截 | 重构 | Planning 模式下调用 bash 返回明确错误 |
| SubAgent 工具白名单 | 重构 | 子 agent 无法调用未声明工具 |
| MemoryPlugin v1 | 新增 | 跨会话 facts 持久化 + 语义检索 |
| Human-in-the-loop | 新增 | bash 写操作触发确认流程 |
| Session 重构 | 重构 | Session 不再是主流程中间层 |

---

## Phase 3：多 Agent 协作（W9–W12）

在 Phase 2 的工具隔离基础上，引入 Planner 和 Multi-agent Orchestration，让复杂任务可以分解到专门的子 agent 并行处理。

---

### 3.1 Planner 组件

Planner 在 agent core 内部，负责把复杂任务分解为子目标列表，交给 loop 逐步执行。**简单任务绕过 Planner，复杂任务走 Planner。**

#### 两种 Plan 模式

**Sequential Plan**（线性步骤列表，适合大多数 coding 任务）

```
Goal: 给 Store 模型加 URL slug 功能

Step 1: 分析现有 Store schema 和相关代码         [researcher]
Step 2: 设计 slug 字段和唯一性约束               [coder]
Step 3: 编写 Elixir migration                   [coder]
Step 4: 更新 Store 的 changeset 函数             [coder]
Step 5: 更新相关 GraphQL schema                  [coder]
Step 6: 运行测试并修复失败用例                   [executor]
```

**DAG Plan**（有依赖的并行步骤，适合多模块同时开发）

```
Step 1: 分析需求                                [researcher]  deps: []
  ├─ Step 2a: 修改后端 API                      [coder]       deps: [1]
  ├─ Step 2b: 更新前端类型定义                   [coder]       deps: [1]
  └─ Step 2c: 更新测试用例                       [coder]       deps: [1]
Step 3: 集成测试                                [executor]    deps: [2a, 2b, 2c]
Step 4: 更新文档                                [documenter]  deps: [3]
```

#### Plan 数据结构

```ts
interface Plan {
  id: string;
  goal: string;
  mode: 'sequential' | 'dag';
  steps: PlanStep[];
  status: 'draft' | 'confirmed' | 'running' | 'done' | 'failed';
  createdAt: number;
}

interface PlanStep {
  id: string;
  title: string;
  description: string;
  deps: string[];                    // 依赖的步骤 id（DAG 模式）
  assignedRole?: AgentRole;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string;
  startedAt?: number;
  endedAt?: number;
}
```

#### Planner 触发判断

```ts
function shouldUsePlanner(message: string, context: IContext): boolean {
  // 1. 用户显式使用 /plan 命令
  if (message.startsWith('/plan')) return true;

  // 2. 消息超过 300 字且包含多个动词
  if (message.length > 300 && countVerbs(message) >= 3) return true;

  // 3. 包含多步骤结构词
  const multiStepPatterns = [/先.*再.*最后/, /同时/, /分步骤/, /step by step/i];
  if (multiStepPatterns.some(p => p.test(message))) return true;

  // 4. 历史对话显示任务未完成（工具调用 > 5 次但没有 final answer）
  if (context.messages.length > 10 && isTaskIncomplete(context)) return true;

  return false;
}
```

#### Human-in-the-loop for Plan

Planner 生成计划后，默认先展示给用户确认：

```
[Planner] 已生成执行计划，共 6 步：

  Step 1: 分析现有 Store schema（researcher）
  Step 2: 设计 slug 字段（coder）
  Step 3: 编写 migration（coder）
  Step 4: 更新 changeset（coder）
  Step 5: 更新 GraphQL schema（coder）
  Step 6: 运行测试（executor）

是否开始执行？[y/N/edit] _
```

**验收条件**

- [ ] `/plan` 命令触发 Planner，生成可读的步骤列表
- [ ] 自动识别复杂任务（> 300 字 + 多动词）触发 Planner
- [ ] Plan 确认后才开始执行，不自动 auto-run
- [ ] Plan 执行进度实时显示（当前步骤 / 总步骤）

---

### 3.2 Multi-agent Orchestration

主 agent（Orchestrator）持有 Planner 生成的计划，把每个步骤分发给对应的专门子 agent，收集结果后聚合。

#### Orchestrator 执行流程

```
用户确认 Plan
  │
  ▼
Orchestrator 持有 Plan
  │
  ├─► 找出所有 deps 已满足的 ready 步骤
  │
  ├─► 按 maxConcurrency 并发启动子 agent
  │     ├─ researcher → 工具集 [read, grep, ls, tavily]
  │     ├─ coder      → 工具集 [read, write, edit, grep]
  │     └─ executor   → 工具集 [read, bash]
  │
  ├─► 步骤完成 → 结果写入 Plan.step.result
  │             → 结果写入 Memory（供后序步骤参考）
  │
  └─► 所有步骤完成 → Orchestrator 做最终聚合回复
```

#### 并发调度实现

```ts
async function runPlan(plan: Plan, opts: OrchestratorOptions): Promise<string> {
  const { maxConcurrency = 3, nodeTimeoutMs = 10 * 60 * 1000 } = opts;

  while (plan.hasIncompleteSteps()) {
    // 找出所有可以执行的步骤（deps 全部完成）
    const ready = plan.steps.filter(s =>
      s.status === 'pending' &&
      s.deps.every(d => plan.getStep(d)?.status === 'done')
    );

    if (ready.length === 0) {
      throw new OrchestratorError('No ready steps: possible dep cycle or upstream failure');
    }

    await Promise.all(
      ready.slice(0, maxConcurrency).map(step => runStep(step, opts))
    );
  }

  return aggregateResults(plan);
}
```

#### 预设 Agent 角色

| 角色 | 工具权限 | 典型任务 |
|------|---------|---------|
| researcher | read, grep, ls, tavily | 代码库分析、文档检索、需求理解 |
| coder | read, write, edit, grep | 代码生成、重构、修改 |
| executor | read, bash | 运行测试、构建、执行命令 |
| reviewer | read, grep, ls | 代码审查、质量检查 |
| documenter | read, write（仅 `.md`） | 文档生成、注释更新 |

**验收条件**

- [ ] Sequential Plan 按顺序执行，失败步骤阻断后续
- [ ] DAG Plan 并发执行无依赖的步骤，`maxConcurrency` 生效
- [ ] 子 agent 超时（`nodeTimeoutMs`）后标记步骤失败，不阻塞整个 Plan
- [ ] 最终聚合结果包含每步骤的执行摘要

---

### 3.3 Agent 间通信（通过 Memory）

子 agent 之间不直接调用，而是通过**共享 Memory** 间接通信，避免紧耦合。

**通信流程示例**

```
Step 1 (researcher) 执行完成
  │
  └─► 自动写入 Memory：
        key: "step:1:result"
        value: "Store schema 在 lib/aurora/catalog/store.ex，
                目前没有 slug 字段，有 name 和 domain_name"

Step 3 (coder) 开始执行
  │
  └─► beforeLLMCall hook 检索 Memory
        query: "Store schema 结构"
        → 找到 Step 1 的结果，注入到 system prompt
        → coder 知道当前 schema 结构，直接写 migration
```

**Memory 写入规范**

```ts
// 步骤完成后（afterRun hook，子 agent 级别）
await memoryService.setFact(`step:${stepId}:result`, result);
await memoryService.setFact(`step:${stepId}:files_changed`, changedFiles.join(','));

// 语义记忆（可被后续步骤模糊检索）
await memoryService.upsert(`step-${stepId}`, result, {
  stepTitle: step.title,
  role: step.assignedRole,
  planId: plan.id,         // planId 隔离，避免跨 Plan 污染
});
```

**验收条件**

- [ ] Step 2 的 coder 能检索到 Step 1 researcher 写入的 Memory
- [ ] 同一个 Plan 内的 Memory 条目有 planId 隔离
- [ ] 跨 Plan 的长期 Memory 仍然可以被检索到

---

### 3.4 Observability 升级：Trace Tree

Phase 3 引入多 agent 后，单一 `requestId` 不够用，需要完整的调用链追踪。

#### Span 模型

```
Trace: plan-abc123
  │
  ├─ Span: orchestrator             latency: 12.3s
  │   ├─ Span: step-1-researcher    latency: 3.1s
  │   │   ├─ Span: llm_call         tokens: 1,200
  │   │   └─ Span: tool:read        duration: 45ms
  │   │
  │   ├─ Span: step-2a-coder        latency: 4.2s  (并发)
  │   │   ├─ Span: llm_call         tokens: 2,100
  │   │   └─ Span: tool:write       duration: 12ms
  │   │
  │   └─ Span: step-3-executor      latency: 5.0s
  │       ├─ Span: llm_call         tokens: 800
  │       └─ Span: tool:bash        duration: 3.2s
  │
  └─ Span: aggregation              latency: 0.8s
```

#### 实现要点

```ts
interface SpanContext {
  traceId: string;         // Plan 级别，整个 Plan 共享
  spanId: string;          // 每个 agent/步骤独立生成
  parentSpanId?: string;   // 子 agent 继承父 spanId
}

// 子 agent 创建时
const subSpan: SpanContext = {
  traceId: parentSpan.traceId,      // 继承
  spanId: generateSpanId(),         // 新生成
  parentSpanId: parentSpan.spanId,  // 指向父
};
```

**Cost Tracking**：记录每个步骤的 token 消耗，支持按 Plan 汇总

```
Plan cost summary:
  Step 1 (researcher):  1,200 tokens  $0.002
  Step 2a (coder):      2,100 tokens  $0.004
  Step 2b (coder):      1,800 tokens  $0.003
  Step 3 (executor):      800 tokens  $0.001
  ─────────────────────────────────────────
  Total:                5,900 tokens  $0.010
```

**输出格式**：兼容 Jaeger JSON，写到 `~/.pulse-coder/traces/<traceId>.json`

**验收条件**

- [ ] 多 agent 调用链可以通过 traceId 完整还原
- [ ] 每个 Plan 执行结束后输出 cost summary
- [ ] Trace JSON 格式可以导入 Jaeger 可视化

---

### Phase 3 交付物汇总

| 交付物 | 类型 | 验收标准 |
|--------|------|---------|
| Planner v1 | 新增 | 自动分解复杂任务为 Plan，用户确认后执行 |
| Orchestrator | 新增 | 并发执行 DAG 步骤，maxConcurrency 生效 |
| Agent 角色体系 | 新增 | 5 种预设角色，工具按角色隔离 |
| Memory 跨 agent 共享 | 扩展 | 后序 agent 能检索前序步骤结果 |
| Trace tree | 新增 | multi-agent 调用链可追踪，支持 cost summary |

---

## 风险与缓解策略

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| Memory 检索引入无关内容，干扰 LLM 输出 | 中 | 高 | 检索结果加相关度阈值（0.70）过滤 |
| Planner 分解任务出错，步骤依赖不合理 | 中 | 中 | Planner 先 dry-run，用户确认 Plan 再执行 |
| 子 agent 并发写同一文件导致冲突 | 低 | 高 | 文件级写锁，同一文件只允许一个 agent 持有写权限 |
| Phase 1 重构破坏现有 CLI 行为 | 低 | 中 | 每个 PR 前跑完整 E2E test suite |
| LLM API 并发调用超出 rate limit | 中 | 低 | Orchestrator 统一限流，指数退避已有实现 |
| Planner 生成 Plan 消耗大量 token | 低 | 低 | Plan 生成使用较小模型，执行用大模型 |

---

## 时间线总览

| 周次 | 阶段 | 主要交付 |
|------|------|---------|
| W1–W2 | Phase 1 | Compaction bug fix · Context 类重构 · ToolRegistry v1 |
| W3–W4 | Phase 1 | ObservabilityLayer · onToolCall 同步化 · Phase 1 E2E 测试 |
| W5–W6 | Phase 2 | Plan Mode 硬拦截 · SubAgent 工具白名单 · Session 重构 |
| W7–W8 | Phase 2 | MemoryPlugin v1 · Human-in-the-loop · Phase 2 集成测试 |
| W9–W10 | Phase 3 | Planner v1 · Orchestrator · Agent 角色体系 |
| W11–W12 | Phase 3 | Memory 跨 agent 共享 · Trace tree · 全链路测试 |

---

## 附录：关键接口速查

### Context 接口

```ts
interface IContext {
  readonly sessionId: string;
  readonly messages: ReadonlyArray<ModelMessage>;
  append(message: ModelMessage): void;
  compact(opts?: CompactOptions): Promise<CompactResult>;
  estimateTokens(): number;
  snapshot(): ContextSnapshot;
  restore(snapshot: ContextSnapshot): void;
}
```

### ToolDefinition 接口

```ts
interface ToolDefinition<I = any, O = any> {
  name: string;
  description: string;
  inputSchema: ZodSchema<I>;
  execute: (input: I, ctx: ExecutionContext) => Promise<O>;
  scope: 'global' | 'restricted' | 'agent-only';
  riskLevel: 'low' | 'medium' | 'high';
  requiresConfirmation?: boolean;
  allowedRoles?: string[];
  defer_loading?: boolean;
}
```

### MemoryService 接口

```ts
interface MemoryService {
  setFact(key: string, value: string, sessionId?: string): Promise<void>;
  getFact(key: string): Promise<string | null>;
  listFacts(prefix?: string): Promise<Array<{ key: string; value: string }>>;
  upsert(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  search(query: string, topK?: number, threshold?: number): Promise<MemoryChunk[]>;
  delete(id: string): Promise<void>;
  buildContext(query: string): Promise<string | null>;
}
```

### Plan 接口

```ts
interface Plan {
  id: string;
  goal: string;
  mode: 'sequential' | 'dag';
  steps: PlanStep[];
  status: 'draft' | 'confirmed' | 'running' | 'done' | 'failed';
  createdAt: number;
}

interface PlanStep {
  id: string;
  title: string;
  description: string;
  deps: string[];
  assignedRole?: AgentRole;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string;
  startedAt?: number;
  endedAt?: number;
}
```

### ObservabilityEvent 接口

```ts
type ObservabilityEvent =
  | { type: 'llm_call'; traceId: string; spanId: string;
      model: string; promptTokens: number; completionTokens: number;
      latencyMs: number; finishReason: string; }
  | { type: 'tool_call'; traceId: string; spanId: string;
      toolName: string; durationMs: number; success: boolean; error?: string; }
  | { type: 'compaction'; traceId: string;
      beforeTokens: number; afterTokens: number; strategy: string; }
  | { type: 'plan_step'; traceId: string; spanId: string;
      stepId: string; role: string; durationMs: number; status: string; };
```

---

*Coding Agent Refactoring Plan · v1.0 · Confidential*