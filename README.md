# Fan Bot

一个轻量级、无框架的 TypeScript AI Agent，支持多 Provider（Anthropic Claude、Ark）和工具调用。具备自动记忆提取、用户隔离、上下文压缩等高级特性。

---

## 特性

### Core
- **多 Provider** - Anthropic Claude / 字节跳动 Ark（火山引擎）
- **多阶段 Agent** - 支持复杂任务的分解和执行
- **web_search** - 实时联网搜索
- **Sub-Agent** - 任务路由到专用子 Agent（Vision/Web Researcher/Coder）

### Memory System
- **混合检索** - 向量搜索 + BM25 混合模式
- **真 BM25** - Okapi BM25 算法，含 IDF 权重和文档长度归一化
- **Cross-Encoder Reranking** - Jina rerank API 支持，结果重排序
- **自适应检索门控** - 智能判断是否需要查记忆
- **自动记忆提取** - 从对话中自动提取关键信息
- **用户隔离** - 记忆按用户隔离，互不干扰
- **上下文压缩** - 上下文过长时自动压缩
- **访问频率影响衰减** - 被频繁访问的记忆半衰期延长，最多延长到基础的 3 倍

### Media Understanding
- **图片理解** - describe_image tool，多格式支持（JPG/PNG/WebP/GIF）
- **音频转写** - whisper 音频转文字

### Feishu Integration
- **消息系统** - 消息接收、回复、卡片消息、流式输出
- **Skills 生态** - 飞书专属技能集（创建文档、搜索内容等）
- **权限管理** - 群组/DM 权限控制

### Cron & Tasks
- **定时任务调度** - agent / notification / shell 三种任务类型
- **签名验证** - HMAC 安全机制
- **主动推送** - 定时任务结果发送到指定飞书聊天

---

## 项目结构

```
fan_bot/
├── src/
│   ├── agent/           # Agent 核心
│   │   ├── loop.ts      # 主循环
│   │   ├── planner.ts   # 任务规划（含 createRoutedPlan）
│   │   ├── sub-agents/  # 子 Agent 系统
│   │   │   ├── types.ts        # AgentType、SubAgentConfig 接口
│   │   │   ├── prompts.ts      # 子 Agent system prompt
│   │   │   ├── registry-builder.ts  # buildSubRegistry 工具函数
│   │   │   └── index.ts        # createSubAgentTools 工厂
│   │   └── memory_extractor.ts  # 记忆提取
│   ├── llm/             # LLM 客户端
│   ├── memory/          # 记忆系统 (LanceDB)
│   ├── session/         # 会话管理
│   ├── tools/           # 工具注册
│   ├── transport/       # 传输层（CLI/HTTP/Feishu）
│   ├── cron/            # Cron 任务调度
│   ├── feishu/          # 飞书集成 + Skills
│   ├── media-understanding/  # 多模态（图片/音频）
│   └── utils/
├── sessions/             # 会话存储（运行时创建）
└── memory/              # 记忆存储（运行时创建）
```

---

## 快速开始

### 1. 安装

```bash
npm install
cp .env.example .env
```

### 2. 配置 .env

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

# Jina API（embeddings + rerank）
JINA_API_KEY=jina_xxx

# Tavily（可选，网页搜索）
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
```

---

## 使用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式，热重载 |
| `npm run start` | 生产运行 |
| `npm run cli` | CLI 交互模式 |
| `npm run test` | 运行测试 |
| `npm run smoke` | 冒烟测试 |

---

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
| `JINA_API_KEY` | Jina API Key |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TRANSPORT` | `cli` | 传输模式：`cli`, `http`, `feishu` |
| `HTTP_PORT` | `3000` | HTTP 服务端口 |
| `SESSION_DIR` | `./sessions` | 会话存储目录 |
| `MAX_CONTEXT_MESSAGES` | `40` | 最大上下文消息数 |
| `MAX_AGENT_ITERATIONS` | `10` | Agent 最大迭代次数 |
| `LOG_MAX_SIZE_MB` | `10` | 日志滚动大小（MB） |
| `LOG_MAX_AGE_DAYS` | `7` | 日志保留天数 |
| `DEBUG` | - | 调试日志命名空间 |

---

## Debug 日志

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
| `agent:prompt` | Prompt 构建 |
| `agent:memory_extractor` | 记忆提取 |
| `memory:lancedb` | LanceDB 记忆 |
| `llm:openai` | OpenAI/Ark API |
| `llm:anthropic` | Anthropic API |
| `feishu:adapter` | 飞书适配器 |
| `feishu:service` | 飞书服务 |
| `session:manager` | 会话管理 |
| `tools:registry` | 工具注册 |

---

## 架构

```
用户输入 → Transport Layer（CLI/HTTP/Feishu）
              ↓
        Session Manager（加载/保存会话）
              ↓
        Memory System（检索相关记忆）
              ↓
        Agent Planner（createRoutedPlan 任务路由）
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
 Calculator  WebSearch  Sub-Agents
              ↓          ↓
              ↓    ┌─────┴─────┐
              ↓    ↓     ↓     ↓
              ↓  Vision  Web   Coder
              ↓ Researcher
              ↓
    Memory Extractor（自动提取记忆）
```

---

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

---

## 飞书 Skills

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

---

## 日志

日志文件位于 `./logs/bot.log`，自动滚动和清理：

- 超过 10MB 自动切割（`bot.log.2026-03-29`）
- 超过 7 天自动删除
- 可通过 `LOG_MAX_SIZE_MB` 和 `LOG_MAX_AGE_DAYS` 自定义
