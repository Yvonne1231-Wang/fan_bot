# Fan Bot

一个轻量级、无框架的 TypeScript AI Agent，支持多 Provider（Anthropic Claude、Ark）和工具调用。具备自动记忆提取、用户隔离、上下文压缩等高级特性。

## 特性

- **多 Provider**：Anthropic Claude / 字节跳动 Ark（火山引擎）
- **混合检索**：向量搜索 + BM25 混合检索
- **真 BM25**：Okapi BM25 算法，含 IDF 权重和文档长度归一化
- **Cross-Encoder Reranking**：Jina rerank API 支持
- **自适应检索门控**：智能判断是否需要查记忆
- **记忆遗忘与强化**：基于间隔重复的记忆衰减机制
- **自动记忆提取**：从对话中自动提取关键信息
- **会话持久化**：JSONL 文件存储，自动压缩
- **Cron 任务**：支持签名验证的安全定时任务
- **飞书集成**：完整的飞书 Skills 生态

## 项目结构

```
fan_bot/
├── src/
│   ├── agent/           # Agent 核心
│   │   ├── loop.ts      # 主循环
│   │   ├── planner.ts   # 任务规划
│   │   ├── memory_extractor.ts  # 记忆提取
│   │   └── smoke_test.ts
│   ├── llm/             # LLM 客户端
│   ├── memory/          # 记忆系统
│   │   └── lancedb-memory.ts   # LanceDB 向量存储
│   ├── session/         # 会话管理
│   ├── tools/           # 工具注册
│   ├── transport/       # 传输层（CLI/HTTP/Feishu）
│   ├── cron/           # Cron 任务调度
│   ├── feishu/         # 飞书集成
│   └── utils/
├── sessions/            # 会话存储（运行时创建）
└── memory/             # 记忆存储（运行时创建）
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```bash
# LLM Provider
LLM_PROVIDER=anthropic

# Anthropic
ANTHROPIC_API_KEY=sk-ant-xxx
ANTHROPIC_MODEL=claude-sonnet-4-6

# 或 Ark（火山引擎）
# LLM_PROVIDER=ark
# ARK_API_KEY=xxx
# ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
# ARK_MODEL=ep-xxx

# Jina API（用于 embeddings 和 reranking）
JINA_API_KEY=jina_xxx

# Tavily（可选，用于网页搜索）
TAVILY_API_KEY=tvly_xxx
```

### 3. 启动

```bash
# CLI 交互模式
npm run cli

# HTTP 服务模式
TRANSPORT=http npm run start

# 飞书机器人模式
TRANSPORT=feishu npm run start

# 开发模式（热重载）
npm run dev
```

## 使用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式，热重载 |
| `npm run start` | 生产运行 |
| `npm run cli` | CLI 交互模式 |
| `npm run http` | HTTP 服务 |
| `npm run feishu` | 飞书机器人 |
| `npm run build` | 编译 TypeScript |
| `npm run typecheck` | 类型检查 |
| `npm run test` | 运行测试 |
| `npm run test:watch` | 测试监听模式 |
| `npm run smoke` | 冒烟测试 |
| `npm run smoke:agent` | Agent 模块测试 |
| `npm run smoke:memory` | Memory 模块测试 |
| `npm run smoke:session` | Session 模块测试 |

## 环境变量

### 必需

| 变量 | 说明 |
|------|------|
| `LLM_PROVIDER` | `anthropic` 或 `ark` |
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `ANTHROPIC_MODEL` | Claude 模型名称 |
| `ARK_API_KEY` | Ark API Key |
| `ARK_BASE_URL` | Ark API 端点 |
| `ARK_MODEL` | Ark 模型 ID |
| `JINA_API_KEY` | Jina API Key（用于 embeddings） |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TRANSPORT` | `cli` | 传输模式：`cli`, `http`, `feishu` |
| `HTTP_PORT` | `3000` | HTTP 服务端口 |
| `SESSION_DIR` | `./sessions` | 会话存储目录 |
| `MAX_CONTEXT_MESSAGES` | `40` | 最大上下文消息数 |
| `MAX_AGENT_ITERATIONS` | `10` | Agent 最大迭代次数 |
| `DEBUG` | - | 调试日志命名空间 |

### Debug 日志

```bash
# 开启所有调试
DEBUG=* npm run cli

# 只看 agent 模块
DEBUG=agent:* npm run cli

# 组合
DEBUG=agent:loop,llm:* npm run cli
```

| 命名空间 | 说明 |
|---------|------|
| `agent:loop` | Agent 主循环 |
| `agent:planner` | 任务规划器 |
| `agent:memory_extractor` | 记忆提取 |
| `memory:lancedb` | LanceDB 记忆 |
| `llm:openai` | OpenAI/Ark API |
| `llm:anthropic` | Anthropic API |
| `session:manager` | 会话管理 |
| `tools:registry` | 工具注册 |

## 架构

```
用户输入 → Transport Layer（CLI/HTTP/Feishu）
              ↓
        Session Manager（加载/保存会话）
              ↓
        Memory System（检索相关记忆）
              ↓
        Agent Planner（任务规划）
              ↓
        Agent Loop（主循环）
              ↓
      ┌───────┴───────┐
      ↓               ↓
  Anthropic        OpenAI/Ark
      ↓               ↓
      └───────┬───────┘
              ↓
       Tool Registry（工具调用）
              ↓
    ┌─────────┼─────────┐
    ↓         ↓         ↓
 Calculator  WebSearch  Cron...
              ↓
    Memory Extractor（自动提取记忆）
```

## 记忆系统

### 检索流程

```
查询 → 自适应门控（跳过打招呼/命令/确认）
                 ↓
       向量搜索 → 相似度阈值过滤(0.85)
                 ↓
       BM25 检索 → Okapi BM25 + IDF
                 ↓
           RRF 融合
                 ↓
       时间新鲜度 boost（半衰期14天）
                 ↓
       长度归一化（锚点500字符）
                 ↓
       Cross-Encoder Rerank（Jina）
                 ↓
             Top-K
```

### 记忆强化机制

- 每次手动检索 → `accessCount +1`
- 访问次数越多 → 半衰期越长 → 衰减越慢
- 30 天不访问 → 强化效果消退
- 对数增长 + 最大 3 倍上限

### 跳过检索的场景

- 打招呼：`hi`/`hello`/`hey`
- 命令：`/xxx`、`git`/`npm`/`docker`
- 确认：`yes`/`no`/`ok`/`好的`
- 纯 Emoji
- 心跳消息：`HEARTBEAT`
- 太短非问句：中文<6字符、英文<15字符

## Cron 任务

```bash
# 列出任务
npm run cron:list

# 手动执行任务
npm run cron:run
```

Cron 任务支持 HMAC 签名验证，防止篡改：

```bash
# 配置签名密钥
CRON_HMAC_SECRET=your-secret
```

## 飞书集成

```bash
# 配置
npm run feishu:config

# 登录
npm run feishu:login

# 状态
npm run feishu:status
```

支持的 Skills：

| Skill | 说明 |
|-------|------|
| `lark-calendar` | 日历日程 |
| `lark-im` | 即时通讯 |
| `lark-doc` | 云文档 |
| `lark-drive` | 云空间 |
| `lark-sheets` | 电子表格 |
| `lark-base` | 多维表格 |
| `lark-task` | 任务管理 |
| `lark-wiki` | 知识库 |
| `lark-contact` | 通讯录 |
| `lark-mail` | 邮箱 |

## 开发

```bash
# 类型检查
npm run typecheck

# 运行测试
npm run test

# 构建
npm run build

# Smoke 测试
npm run smoke
```
