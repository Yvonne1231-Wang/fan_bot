# Fan Bot 优化计划：对标 Hermes Agent v0.8

> 版本：1.0.0
> 创建时间：2026-04-14
> 基于对比：Hermes Agent v0.8（Nous Research，2026-02）

---

## 目录

1. [背景与分析方法](#1-背景与分析方法)
2. [优化全景一览](#2-优化全景一览)
3. [P0 — 持久化用户画像](#3-p0--持久化用户画像)
4. [P0 — 子代理上下文隔离](#4-p0--子代理上下文隔离)
5. [P1 — 会话历史 FTS5 归档与混合检索](#5-p1--会话历史-fts5-归档与混合检索)
6. [P1 — 可插拔记忆后端](#6-p1--可插拔记忆后端)
7. [P2 — 自进化技能系统](#7-p2--自进化技能系统)
8. [P2 — 事件驱动后台任务](#8-p2--事件驱动后台任务)
9. [实施路线图](#9-实施路线图)
10. [风险与缓解](#10-风险与缓解)

---

## 1. 背景与分析方法

### 1.1 Hermes Agent v0.8 概要

Hermes Agent（Nous Research，GitHub 61K+ stars）v0.8 引入了一系列先进的 Agent 架构模式：

| 特性 | 描述 |
|---|---|
| 闭环学习 | 成功任务自动提炼为技能，技能在使用中持续自优化 |
| 多层级持久记忆 | MEMORY.md/USER.md 注入每个会话；FTS5 全文检索（~10ms / 10K 条） |
| 辩证用户建模 | Honcho 框架，结构化用户画像持续修正 |
| 子代理隔离 | 独立对话 + 独立终端/RPC，零上下文成本并行管道 |
| Git Worktree 并行 | 隔离分支做并行任务 |
| 后台任务自动通知 | 无需轮询，事件驱动推送 |
| 可插拔记忆后端 | Provider 接口 + 凭证轮换支持 |
| agentskills.io 开放标准 | 可分享的技能格式 |

### 1.2 Fan Bot 现状

Fan Bot 当前架构（104 个 TypeScript 源文件）已具备：

- **AsyncLocalStorage 请求隔离**（`runWithContext()`）
- **LanceDB 混合搜索**（向量 + BM25，RRF 融合）
- **LLM 摘要压缩**（`SessionManager.compress()` + `summarizeMessages()`）
- **Plan 模式**（`shouldPlan()` → `createPlan()` + 顺序 `runAgent()`）
- **Team Agent 多代理**（`AgentTeam.executeTask()` 并行执行）
- **Cron 定时任务**
- **多 Transport 适配**（Feishu / CLI / HTTP）
- **声明式技能系统**（`.fan_bot/skills/` + SKILL.md）

### 1.3 Gap 分析

对标 Hermes 后发现 6 个可改进维度，按投入产出比排序如下表。

---

## 2. 优化全景一览

| # | 优化项 | 优先级 | 复杂度 | 涉及模块 | 核心收益 |
|---|---|---|---|---|---|
| 1 | 持久化用户画像 | **P0** | 低 | `memory_extractor` / 新增 `user-profile` | 跨会话确定性注入，消除召回遗漏 |
| 2 | 子代理上下文隔离 | **P0** | 中 | `agent/team/*` | Token 消耗降 50%+，故障隔离 |
| 3 | 会话历史 FTS5 归档 | **P1** | 中 | 新增 `session-archive`，扩展 `session/` | 精确跨会话检索（"上次那个方案"） |
| 4 | 可插拔记忆后端 | **P1** | 中 | `memory/*` 重构 | 架构解耦，支持多存储切换 |
| 5 | 自进化技能系统 | **P2** | 高 | `skills/*` + `agent/loop.ts` | 技能自动生成 + 持续优化 |
| 6 | 事件驱动后台任务 | **P2** | 中 | `cron/*` + `transport/feishu-adapter` | 长任务不阻塞会话，异步推送结果 |

---

## 3. P0 — 持久化用户画像

### 3.1 问题

当前用户偏好散落在 LanceDB 记忆条目中，每次会话需要通过向量召回来获取。存在两个风险：
1. **召回不稳定**：相关偏好可能因 embedding 相似度不够而被遗漏
2. **无结构化建模**：无法区分"技术偏好""沟通风格""常用项目"等不同类别

Hermes 使用 `MEMORY.md` + `USER.md` 在每个会话 system prompt 中确定性注入，零召回延迟。

### 3.2 设计方案

#### 3.2.1 数据结构

新增 `src/user/profile.ts`：

```typescript
export interface UserProfile {
  userId: string;
  updatedAt: number;
  sections: {
    /** 技术栈偏好：语言、框架、代码风格 */
    techPreferences: string[];
    /** 沟通偏好：详细/简洁、语言、格式 */
    communicationStyle: string[];
    /** 常用项目/仓库 */
    activeProjects: Array<{ name: string; path: string; description: string }>;
    /** 历史决策记录（"用户倾向于 X 而非 Y"） */
    decisions: Array<{ topic: string; preference: string; date: number }>;
    /** 自由形式备忘 */
    notes: string[];
  };
}
```

#### 3.2.2 存储

用户画像以 JSON 文件存储在 `.fan_bot/user_profiles/{userId}.json`，理由：
- 确定性读取，零延迟（不依赖向量搜索）
- 可 Git 追踪变更历史
- 人工可读可编辑

#### 3.2.3 自动更新

在 `src/agent/memory_extractor.ts` 的 `extractMemories()` 函数末尾增加 ProfileUpdater 钩子：

```typescript
// memory_extractor.ts - 新增逻辑
export async function extractMemories(
  messages: Message[],
  llmClient: LLMClient,
  memory: MemoryService,
): Promise<MemoryExtractionResult> {
  // ... 现有逻辑 ...

  // 新增：提取用户画像更新
  await updateUserProfile(messages, llmClient, userId);

  return result;
}
```

新增 `src/user/profile-updater.ts`：
- 每次对话结束后，用 LLM 判断对话中是否包含新的用户偏好信息
- 如果有，增量更新 `UserProfile` 对应 section
- 使用 JSON Merge Patch 语义，只修改变更部分

#### 3.2.4 注入方式

修改 `src/agent/prompt.ts`，在构建 system prompt 时读取用户画像：

```typescript
function buildSystemPrompt(userId: string): string {
  const profile = loadUserProfile(userId);
  const profileSection = profile
    ? formatProfileForPrompt(profile)
    : '';
  return `${BASE_SYSTEM_PROMPT}\n\n${profileSection}`;
}
```

### 3.3 涉及文件

| 操作 | 文件路径 |
|---|---|
| 新增 | `src/user/profile.ts` — 类型定义 |
| 新增 | `src/user/profile-updater.ts` — 自动更新逻辑 |
| 新增 | `src/user/profile-updater.test.ts` — 测试 |
| 修改 | `src/agent/memory_extractor.ts` — 增加 ProfileUpdater 钩子 |
| 修改 | `src/agent/prompt.ts` — system prompt 注入画像 |

### 3.4 验收标准

- [ ] 对话中说 "我喜欢用 Vim"，下次会话 system prompt 中包含该偏好
- [ ] 用户画像文件可读可编辑
- [ ] 画像更新为增量式，不会丢失已有条目
- [ ] 单元测试覆盖 ProfileUpdater 的提取 / 合并 / 冲突解决逻辑

---

## 4. P0 — 子代理上下文隔离

### 4.1 问题

当前 `AgentTeam.executeTask()` 中，每个子代理通过 `runAgent()` 运行，父级上下文（包括完整 messages 数组）会传递给子代理。这导致：

1. **Token 浪费**：N 个子代理 × 全量上下文 = O(N × context_size) 的 token 消耗
2. **信息泄漏**：子代理之间的中间结果互相可见，可能导致干扰
3. **故障传播**：一个子代理的异常输出可能污染共享 messages

Hermes 的子代理拥有独立对话、独立终端和 RPC 通道，实现零上下文成本并行管道。

### 4.2 设计方案

#### 4.2.1 TaskContext 精简结构

新增 `src/agent/team/task-context.ts`：

```typescript
export interface TaskContext {
  /** 任务 ID */
  taskId: string;
  /** 任务目标描述（来自 lead agent 分配） */
  objective: string;
  /** 共享状态摘要（由 lead 构建，非完整历史） */
  sharedContext: string;
  /** 允许使用的工具列表（子集） */
  allowedTools: string[];
  /** 结果上报格式约束 */
  outputSchema: Record<string, unknown>;
}
```

#### 4.2.2 子代理执行改造

修改 `src/agent/team/agent.ts` 中的 `executeTask()` 方法：

**Before（当前）：**
```typescript
// 子代理继承完整 messages
const result = await runAgent({
  prompt: task.description,
  initialMessages: this.messages, // ← 全量上下文
  ...
});
```

**After（目标）：**
```typescript
// 子代理只接收精简 TaskContext
const taskContext = buildTaskContext(task, this.messages);
const result = await runAgent({
  prompt: taskContext.objective,
  initialMessages: [], // ← 空！仅靠 system prompt 注入 sharedContext
  systemPrompt: buildAgentSystemPrompt(agent, taskContext),
  ...
});
```

#### 4.2.3 结果回传

子代理执行完成后，通过结构化 JSON 回传结果（而非拼入 messages）：

```typescript
interface AgentTaskResult {
  taskId: string;
  agentId: string;
  status: 'success' | 'failed' | 'partial';
  output: string;
  artifacts?: Array<{ name: string; content: string }>;
  tokensUsed: { input: number; output: number };
}
```

Lead agent 收到所有子代理结果后，在自己的上下文中综合分析，不需要看到子代理的中间过程。

#### 4.2.4 进阶：进程级隔离（Phase 2）

第一阶段先做逻辑隔离（empty initialMessages + TaskContext）。待验证效果后，可进一步：
- 使用 `worker_threads` 运行子代理
- 每个 worker 有独立的 `AsyncLocalStorage` 上下文
- 通过 `MessagePort` 传递 `TaskContext` 和 `AgentTaskResult`

### 4.3 涉及文件

| 操作 | 文件路径 |
|---|---|
| 新增 | `src/agent/team/task-context.ts` — TaskContext 类型 + 构建函数 |
| 新增 | `src/agent/team/task-context.test.ts` — 测试 |
| 修改 | `src/agent/team/agent.ts` — executeTask() 改用 TaskContext |
| 修改 | `src/agent/team/types.ts` — 新增 AgentTaskResult 类型 |
| 修改 | `src/agent/team/run.ts` — 结果回传改为结构化 JSON |

### 4.4 验收标准

- [ ] 子代理 `initialMessages` 为空，仅通过 system prompt 获得任务上下文
- [ ] 同一任务下，token 消耗对比降低 40% 以上
- [ ] 子代理执行失败不影响其他子代理和 lead agent
- [ ] `AgentTeam.executeTask()` 的现有测试全部通过

---

## 5. P1 — 会话历史 FTS5 归档与混合检索

### 5.1 问题

当前 `SessionManager.compress()` 使用 LLM 将旧消息压缩为摘要。压缩后原始上下文**不可逆地丢失**——当用户说"上次那个方案"或"之前讨论的 X"时，如果摘要中没有包含足够细节，就无法定位。

Hermes 使用 SQLite FTS5 索引归档会话，实现 ~10ms 级别的全文检索（10K+ 条记录），按需搜索而非全量加载。

### 5.2 设计方案

#### 5.2.1 会话归档模块

新增 `src/session/archive.ts`：

```typescript
import Database from 'better-sqlite3';

export interface SessionArchive {
  /** 归档一次完整会话 */
  archive(sessionId: string, messages: Message[]): Promise<void>;
  /** FTS5 全文检索 */
  search(query: string, options?: ArchiveSearchOptions): Promise<ArchiveResult[]>;
  /** 按会话 ID 检索 */
  getSession(sessionId: string): Promise<ArchivedMessage[]>;
  /** 统计信息 */
  stats(): Promise<{ totalSessions: number; totalMessages: number }>;
}

export interface ArchiveSearchOptions {
  userId?: string;
  /** 只搜最近 N 天 */
  maxAgeDays?: number;
  /** 返回条数 */
  limit?: number;
}

export interface ArchiveResult {
  sessionId: string;
  messageIndex: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** FTS5 rank score */
  score: number;
  /** 上下文窗口（前后各 2 条消息） */
  contextWindow: ArchivedMessage[];
}
```

#### 5.2.2 SQLite Schema

```sql
CREATE TABLE archived_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_names TEXT,          -- JSON array of tool names used
  timestamp INTEGER NOT NULL,
  UNIQUE(session_id, message_index)
);

CREATE VIRTUAL TABLE archived_messages_fts USING fts5(
  content,
  tool_names,
  content='archived_messages',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- 触发器保持 FTS 索引同步
CREATE TRIGGER archived_messages_ai AFTER INSERT ON archived_messages BEGIN
  INSERT INTO archived_messages_fts(rowid, content, tool_names)
    VALUES (new.id, new.content, new.tool_names);
END;
```

#### 5.2.3 归档时机

在 `SessionManager.compress()` 执行前，先将原始消息写入归档：

```typescript
// session/manager.ts - 修改 compress()
async compress(messages: Message[]): Promise<Message[]> {
  // 新增：归档原始消息到 SQLite
  await this.archive.archive(this.currentSessionId, messages);

  // 现有逻辑：LLM 摘要压缩
  const summary = await summarizeMessages(messages, this.llmClient);
  return [summaryMessage(summary)];
}
```

#### 5.2.4 检索链路

修改 `src/memory/lancedb-memory.ts` 的 `buildContext()` 方法，增加 FTS5 检索通道：

```
用户 query
    ├─→ LanceDB 向量检索（语义相似度）
    ├─→ FTS5 全文检索（精确关键词匹配）
    └─→ RRF 融合排序 → 去重 → Top K 结果
```

### 5.3 涉及文件

| 操作 | 文件路径 |
|---|---|
| 新增 | `src/session/archive.ts` — FTS5 归档模块 |
| 新增 | `src/session/archive.test.ts` — 测试 |
| 修改 | `src/session/manager.ts` — compress() 前触发归档 |
| 修改 | `src/memory/lancedb-memory.ts` — buildContext() 增加 FTS5 通道 |
| 新增 | 依赖：`better-sqlite3`（已是 Node.js 生态成熟方案） |

### 5.4 验收标准

- [ ] 压缩后的会话原始内容可通过关键词精确检索
- [ ] 检索延迟 < 50ms（10K 条记录内）
- [ ] "上次讨论的 X" 类查询能返回包含上下文窗口的结果
- [ ] 归档不影响现有 compress() 性能（异步写入）

---

## 6. P1 — 可插拔记忆后端

### 6.1 问题

当前 `src/memory/index.ts` 中 `getMemory()` 硬编码返回 `LanceDBMemoryService`：

```typescript
// 现状
export function getMemory(): MemoryService {
  if (!globalMemory) {
    globalMemory = new LanceDBMemoryService(); // ← 硬编码
  }
  return globalMemory;
}
```

如果需要切换到 SQLite（配合 FTS5）、Redis（高速缓存）、或远程服务，必须修改源码。

Hermes v0.7.0 引入了 Pluggable Memory Providers 接口，支持配置级切换和凭证轮换。

### 6.2 设计方案

#### 6.2.1 Provider 接口

当前 `MemoryService` 接口（`src/memory/types.ts`）已经定义了标准方法签名，可以直接复用作为 Provider 接口。关键改动在工厂层。

#### 6.2.2 Provider 工厂

新增 `src/memory/factory.ts`：

```typescript
import type { MemoryService } from './types.js';

export type MemoryBackend = 'lancedb' | 'sqlite' | 'json';

export interface MemoryConfig {
  backend: MemoryBackend;
  /** LanceDB specific */
  lancedb?: {
    dbPath?: string;
    embeddingModel?: string;
  };
  /** SQLite specific (for FTS5 archive integration) */
  sqlite?: {
    dbPath?: string;
  };
  /** JSON specific (lightweight, for testing) */
  json?: {
    filePath?: string;
  };
}

export async function createMemoryService(
  config: MemoryConfig,
): Promise<MemoryService> {
  switch (config.backend) {
    case 'lancedb': {
      const { LanceDBMemoryService } = await import('./lancedb-memory.js');
      return new LanceDBMemoryService(config.lancedb);
    }
    case 'sqlite': {
      const { SQLiteMemoryService } = await import('./sqlite-memory.js');
      return new SQLiteMemoryService(config.sqlite);
    }
    case 'json': {
      const { JsonMemoryService } = await import('./json-memory.js');
      return new JsonMemoryService(config.json?.filePath);
    }
    default:
      throw new Error(`Unknown memory backend: ${config.backend}`);
  }
}
```

#### 6.2.3 入口改造

修改 `src/memory/index.ts`：

```typescript
import type { MemoryService } from './types.js';
import { createMemoryService, type MemoryConfig } from './factory.js';

let globalMemory: MemoryService | null = null;

export async function initMemory(config: MemoryConfig): Promise<MemoryService> {
  globalMemory = await createMemoryService(config);
  return globalMemory;
}

export function getMemory(): MemoryService {
  if (!globalMemory) {
    throw new Error('Memory not initialized. Call initMemory() first.');
  }
  return globalMemory;
}
```

#### 6.2.4 配置来源

在 `.fan_bot/config.json` 中增加 memory 配置：

```json
{
  "memory": {
    "backend": "lancedb",
    "lancedb": {
      "dbPath": ".fan_bot/memory/lancedb"
    }
  }
}
```

### 6.3 涉及文件

| 操作 | 文件路径 |
|---|---|
| 新增 | `src/memory/factory.ts` — Provider 工厂 |
| 新增 | `src/memory/factory.test.ts` — 测试 |
| 新增 | `src/memory/sqlite-memory.ts` — SQLite Provider（可选，与 FTS5 归档复用） |
| 修改 | `src/memory/index.ts` — 改用工厂模式 |
| 修改 | `src/bootstrap/shared.ts` — 启动时调用 `initMemory()` |
| 修改 | `src/memory/lancedb-memory.ts` — 构造函数接受配置参数 |

### 6.4 验收标准

- [ ] 通过配置文件切换 backend，无需修改代码
- [ ] 现有 LanceDB 功能完全兼容（所有测试通过）
- [ ] `getMemory()` 未初始化时抛出明确错误而非返回 null
- [ ] JsonMemoryService 可用于测试环境（无外部依赖）

---

## 7. P2 — 自进化技能系统

### 7.1 问题

当前技能系统是**静态声明式**的：
- 技能定义在 `.fan_bot/skills/*/SKILL.md`
- 内容由人工编写和维护
- 无使用反馈、无自动优化

Hermes 实现了闭环学习：成功任务 → 自动提炼为技能 → 技能在使用中自我优化。

### 7.2 设计方案

#### 7.2.1 技能生命周期

```
[任务完成] → [评估复用价值] → [提炼技能草稿] → [人工确认/自动存储]
                                                         ↓
                                              [技能被调用] → [收集反馈]
                                                         ↓
                                              [达到优化阈值] → [LLM 优化技能]
```

#### 7.2.2 技能元数据扩展

修改 `src/skills/types.ts`：

```typescript
export interface SkillMetadata {
  name: string;
  description: string;
  alwaysActive?: boolean;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;

  // 新增字段
  /** 技能来源：manual（人工创建）| auto（自动提取） */
  source?: 'manual' | 'auto';
  /** 使用统计 */
  stats?: {
    usageCount: number;
    successCount: number;
    lastUsedAt: number;
    averageRating?: number;
  };
  /** 版本号，每次优化递增 */
  version?: number;
}
```

#### 7.2.3 SkillExtractor

新增 `src/skills/extractor.ts`：

```typescript
export interface SkillExtractionConfig {
  /** 自动提取阈值：相似任务出现 N 次后触发 */
  autoExtractThreshold: number;
  /** 是否需要人工确认 */
  requireConfirmation: boolean;
  /** 优化阈值：使用 N 次后触发 LLM 优化 */
  optimizeAfterUses: number;
}

export class SkillExtractor {
  /**
   * 分析对话判断是否可提炼为技能
   * 触发条件：
   * 1. 用户明确说"以后都这样做"
   * 2. 同类任务出现 >= autoExtractThreshold 次
   * 3. 任务包含多步骤工具调用链
   */
  async evaluate(messages: Message[]): Promise<SkillCandidate | null>;

  /** 从对话中提炼技能 SKILL.md 内容 */
  async extract(messages: Message[]): Promise<SkillDraft>;

  /** 优化已有技能（基于使用反馈） */
  async optimize(skill: Skill, feedback: SkillFeedback[]): Promise<string>;
}
```

#### 7.2.4 集成点

在 `src/agent/loop.ts` 的 `runAgent()` 末尾（finally 阶段）：

```typescript
// agent/loop.ts - finally 阶段
if (options.autoExtractSkills) {
  const candidate = await skillExtractor.evaluate(messages);
  if (candidate) {
    if (config.requireConfirmation) {
      // 通过 onText 回调通知用户
      options.onText?.(`\n\n💡 发现可复用模式，是否保存为技能？`);
    } else {
      await skillExtractor.extract(messages);
    }
  }
}
```

### 7.3 涉及文件

| 操作 | 文件路径 |
|---|---|
| 新增 | `src/skills/extractor.ts` — 技能提取器 |
| 新增 | `src/skills/extractor.test.ts` — 测试 |
| 新增 | `src/skills/optimizer.ts` — 技能优化器 |
| 修改 | `src/skills/types.ts` — 扩展 SkillMetadata |
| 修改 | `src/agent/loop.ts` — finally 阶段集成 |
| 修改 | `src/skills/loader.ts` — 支持 stats 字段读写 |

### 7.4 验收标准

- [ ] 多步骤工具调用任务可被自动识别为技能候选
- [ ] 生成的 SKILL.md 格式规范、可直接使用
- [ ] 使用次数和成功率被正确追踪
- [ ] 技能优化不破坏已有功能


### 7.5 触发时机与集成架构

#### 7.5.1 触发时机：每轮对话结束

技能提取**不依赖 session 生命周期**——fan_bot 的 session 没有"结束"概念（只有压缩，没有关闭）。
触发点是 `handler.ts` 中每次用户消息处理完成后的后台任务区域，与 memory-extract、profile-update 并列：

```
用户发消息 → runAgent() → save session
                              ↓ (并行后台任务)
                    ├─ session-compress
                    ├─ memory-extract
                    ├─ profile-update
                    └─ skill-evaluate  ← 新增
```

#### 7.5.2 触发条件（3 选 1）

| 条件 | 判定方式 | 说明 |
|------|---------|------|
| 用户显式请求 | 对话中含"以后都这样做"、"保存为技能" | 最高优先级，直接进提取 |
| 多步工具调用链 | `result.messages` 中连续 tool_use ≥ 3 个 | 复杂流程任务 |
| 相似任务重复出现 | FTS5 archive.search() 匹配同类任务 ≥ N 次 | 高频模式 |

#### 7.5.3 集成代码

```typescript
// handler.ts — 与 memory-extract、profile-update 并列
runBackgroundTask('skill-evaluate', async () => {
  // 快速过滤：tool_use < 3 且没有显式请求 → 直接跳过
  // 绝大多数普通对话在这里返回，开销接近 0
  const toolUseCount = countToolUses(result.messages);
  if (toolUseCount < 3 && !hasExplicitSkillRequest(prompt)) return;

  // 只有多步工具调用或显式请求才进入 LLM 评估
  const candidate = await skillExtractor.evaluate(result.messages);
  if (!candidate) return;

  if (config.requireConfirmation) {
    // 暂存到 .fan_bot/pending_skills/，下轮对话提示用户确认
    await savePendingSkill(candidate);
  } else {
    await skillExtractor.extract(result.messages);
  }
});
```

#### 7.5.4 性能保障

| 关注点 | 解法 |
|--------|------|
| 性能 | 先用纯计算快速过滤（数 tool_use 数量），99% 普通对话直接 return，不调 LLM |
| 重复提取 | evaluate 里查 FTS5 archive + 已有 skills 去重 |
| 不阻塞 | `runBackgroundTask` 异步执行，用户无感知 |

#### 7.5.5 待确认技能的生命周期

```
evaluate() → SkillCandidate
  → savePendingSkill() → .fan_bot/pending_skills/{name}.json
  → 下轮对话 system prompt 提示："有待确认的技能草稿"
  → 用户说"确认" → extract() → 写入 .fan_bot/skills/{name}/SKILL.md
  → 用户说"取消" → 删除 pending
  → 超过 7 天未确认 → 自动清理
```
---

## 8. P2 — 事件驱动后台任务

### 8.1 问题

当前 `src/cron/executor.ts` 执行任务时是同步阻塞的——长任务占用当前会话。用户说"帮我跑个分析脚本"后必须等待完成才能继续对话。

Hermes 的后台任务在独立上下文中执行，完成后自动推送通知。

### 8.2 设计方案

#### 8.2.1 BackgroundTaskManager

新增 `src/task/background.ts`：

```typescript
export interface BackgroundTask {
  id: string;
  userId: string;
  description: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

export interface BackgroundTaskManager {
  /** 提交后台任务 */
  submit(task: BackgroundTaskSubmission): Promise<string>;
  /** 查询任务状态 */
  getStatus(taskId: string): Promise<BackgroundTask>;
  /** 列出用户的后台任务 */
  listTasks(userId: string): Promise<BackgroundTask[]>;
  /** 取消任务 */
  cancel(taskId: string): Promise<void>;
}
```

#### 8.2.2 执行隔离

后台任务在独立的 `AsyncLocalStorage` 上下文中运行：

```typescript
async function executeBackground(task: BackgroundTaskSubmission): Promise<void> {
  await runWithContext(
    { userId: task.userId, sessionId: `bg-${task.id}` },
    async () => {
      const result = await runAgent({
        prompt: task.prompt,
        llmClient: task.llmClient,
        toolRegistry: task.toolRegistry,
        maxIterations: task.maxIterations ?? DEFAULT_CRON_MAX_ITERATIONS,
      });

      // 通过 Feishu 消息卡片推送结果
      await notifyResult(task.userId, task.id, result);
    },
  );
}
```

#### 8.2.3 用户交互

新增 `background_task` 工具，供 Agent 在对话中使用：

```typescript
{
  name: 'background_task',
  description: '将长时间运行的任务提交到后台执行。任务完成后会主动通知你结果。',
  parameters: {
    task: { type: 'string', description: '任务描述' },
    notify: { type: 'boolean', description: '完成后是否通知', default: true },
  },
}
```

Agent 可以自行判断何时将任务放入后台（如预估执行时间 > 2 分钟）。

### 8.3 涉及文件

| 操作 | 文件路径 |
|---|---|
| 新增 | `src/task/background.ts` — BackgroundTaskManager |
| 新增 | `src/task/background.test.ts` — 测试 |
| 新增 | `src/tools/background.ts` — background_task 工具定义 |
| 修改 | `src/feishu/adapter.ts` — 增加主动推送 API |
| 修改 | `src/tools/registry.ts` — 注册新工具 |

### 8.4 验收标准

- [ ] 长任务提交后立即返回，用户可继续对话
- [ ] 任务完成后通过飞书消息卡片推送结果
- [ ] 任务失败时推送错误信息
- [ ] 后台任务使用独立的 AsyncLocalStorage 上下文

---

## 9. 实施路线图

```
Phase 1（1-2 周）：P0 项
├── Week 1: 持久化用户画像
│   ├── Day 1-2: UserProfile 类型 + 存储层
│   ├── Day 3-4: ProfileUpdater + LLM 提取逻辑
│   └── Day 5:   system prompt 注入 + 集成测试
│
└── Week 2: 子代理上下文隔离
    ├── Day 1-2: TaskContext 设计 + 构建函数
    ├── Day 3-4: AgentTeam.executeTask() 重构
    └── Day 5:   Token 消耗对比验证

Phase 2（3-4 周）：P1 项
├── Week 3: 会话历史 FTS5 归档
│   ├── Day 1-2: SQLite schema + archive 模块
│   ├── Day 3-4: compress() 集成归档
│   └── Day 5:   buildContext() 增加 FTS5 通道
│
└── Week 4: 可插拔记忆后端
    ├── Day 1-2: Provider 工厂 + 配置系统
    ├── Day 3:   LanceDB Provider 改造
    ├── Day 4:   SQLite Provider（复用 archive）
    └── Day 5:   启动流程改造 + 集成测试

Phase 3（5-6 周）：P2 项
├── Week 5: 自进化技能系统
│   ├── Day 1-2: SkillExtractor 评估 + 提取
│   ├── Day 3-4: agent/loop.ts 集成
│   └── Day 5:   技能优化器
│
└── Week 6: 事件驱动后台任务
    ├── Day 1-2: BackgroundTaskManager
    ├── Day 3:   background_task 工具
    └── Day 4-5: Feishu 主动推送 + 集成测试
```

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 用户画像更新导致 prompt 过长 | Token 消耗增加 | 设置画像最大长度（2000 字符），超出时 LLM 压缩 |
| FTS5 索引体积膨胀 | 磁盘占用增长 | 设置归档保留策略（默认 90 天），超期自动清理 |
| 子代理上下文太少导致任务失败 | 任务成功率下降 | sharedContext 构建需保留关键上下文；失败时自动回退到全量上下文 |
| 自动提取的技能质量不稳定 | 误导后续任务 | 默认需人工确认；低成功率技能自动禁用 |
| better-sqlite3 原生依赖安装问题 | 部署失败 | 提供 prebuild binary；备选使用 sql.js（纯 WASM） |
| 后台任务资源竞争 | 主会话响应变慢 | 设置并发上限（默认 3）；后台任务使用低优先级 LLM 配额 |
