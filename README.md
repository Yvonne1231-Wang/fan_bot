# Fan Bot

一个轻量级、无框架的 TypeScript AI Agent，支持多 Provider（Anthropic Claude、Ark）和工具调用。具备自动记忆提取、用户隔离、上下文压缩等高级特性。

## 项目结构

```
fan_bot/
├── src/
│   ├── agent/           # Agent 核心逻辑
│   │   ├── loop.ts      # 主循环：调用 LLM、处理工具调用
│   │   ├── planner.ts   # 任务规划器
│   │   └── smoke_test.ts # Agent 模块测试
│   ├── llm/             # LLM 客户端抽象层
│   │   ├── anthropic.ts # Anthropic Claude API 实现
│   │   ├── openai.ts    # OpenAI/Ark API 实现
│   │   └── types.ts     # 共享类型定义
│   ├── memory/          # 记忆管理
│   │   ├── store.ts     # 记忆存储（向量搜索 + BM25）
│   │   ├── types.ts     # 记忆类型定义
│   │   └── extractor.ts # 记忆自动提取器
│   ├── session/         # 会话持久化管理
│   │   ├── store.ts     # JSONL 文件存储
│   │   ├── manager.ts   # 会话管理器（加载/保存/裁剪）
│   │   └── smoke_test.ts # Session 模块测试
│   ├── tools/           # 工具注册与内置工具
│   │   ├── registry.ts  # 工具注册表
│   │   ├── calculator.ts # 内置计算器
│   │   └── web_search.ts # 网页搜索工具
│   ├── transport/       # 传输层
│   │   └── cli.ts       # 命令行交互模式
│   ├── utils/
│   │   └── debug.ts     # 调试日志工具
│   └── index.ts         # 应用入口
├── dist/                # TypeScript 编译输出
├── sessions/            # 会话文件存储目录（运行时创建）
└── memory/              # 记忆文件存储目录（运行时创建）
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，填入你的 API Key：

```bash
cp .env.example .env
```

编辑 `.env`：

```bash
# 选择提供商：anthropic 或 ark
LLM_PROVIDER=ark

# Ark（字节跳动火山引擎）
ARK_API_KEY=your-ark-api-key
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL=ep-your-endpoint-id

# 或使用 Anthropic
# ANTHROPIC_API_KEY=sk-ant-xxx
# ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

### 4. 配置飞书 CLI（可选）

如果你需要使用飞书相关功能，需要安装飞书 CLI：

```bash
npm install
```

首次使用需要配置：

```bash
# 初始化配置
npm run feishu:config

# 登录授权
npm run feishu:login

# 查看登录状态
npm run feishu:status
```

详细说明见下方「飞书 CLI」章节。

### 5. 启动 CLI

```bash
npm run cli
```

交互示例：

```
Fan Bot Agent
Version: 1.0.0
User: fan
Session: 1753681234567-abc123

> 你好
你好！我是你的 AI 助手，很高兴见到你。有什么我可以帮助你的吗？

> 搜索一下最新的 AI 新闻
我来为你搜索最新的 AI 新闻。

[使用工具: web_search]
[搜索结果...]

> 你还记得我叫什么吗？
当然记得，你叫 fan。我们之前聊过天。

> exit
保存记忆...
再见！期待下次和你聊天。
```

## 调试日志

通过环境变量 `DEBUG` 控制调试输出：

```bash
# 开启所有调试日志
DEBUG=* npm run cli

# 只看 agent 模块
DEBUG=agent:* npm run cli

# 只看 LLM 调用
DEBUG=llm:* npm run cli

# 组合多个模块
DEBUG=agent:loop,llm:* npm run cli

# 关闭调试（默认）
npm run cli
```

调试日志命名空间：

| 命名空间 | 说明 |
|---------|------|
| `agent:loop` | Agent 主循环 |
| `agent:planner` | 任务规划器 |
| `llm:openai` | OpenAI/Ark API 调用 |
| `llm:anthropic` | Anthropic API 调用 |
| `session:manager` | 会话管理 |
| `memory:store` | 记忆存储 |
| `memory:extractor` | 记忆提取器 |
| `tools:registry` | 工具注册 |
| `tools:web_search` | 网页搜索工具 |

## 运行测试

```bash
# 运行 session 模块测试（不需要 API Key）
npx tsx src/session/smoke_test.ts

# 运行 agent 模块测试（需要 API Key）
npx tsx src/agent/smoke_test.ts

# 运行记忆模块测试（需要 API Key）
npx tsx src/memory/smoke_test.ts

# 类型检查
npm run typecheck

# 构建
npm run build
```

## 架构说明

```
用户输入 → transport/cli.ts (REPL)
              ↓
        session/manager.ts (加载/保存会话)
              ↓
        memory/store.ts (检索相关记忆)
              ↓
         agent/planner.ts (任务规划)
              ↓
         agent/loop.ts (主循环)
              ↓
      ┌───────┴───────┐
      ↓               ↓
  llm/anthropic.ts 或 llm/openai.ts (调用 LLM)
      ↓               ↓
      └───────┬───────┘
              ↓
       tools/registry.ts (工具调用)
              ↓
    ┌─────────┼─────────┐
    ↓         ↓         ↓
calculator.ts  web_search.ts  ... (更多工具)
              ↓
      memory/extractor.ts (自动提取记忆)
```

## 核心特性

### 1. 多 Provider 支持
- Anthropic Claude
- 字节跳动 Ark（火山引擎）

### 2. 智能记忆系统
- **向量搜索 + BM25** 混合检索
- **自动记忆提取**：从对话中自动提取关键信息
- **用户隔离**：多用户场景下数据完全隔离
- **上下文压缩**：智能裁剪保留关键信息

### 3. 工具生态
- 内置计算器
- 网页搜索（Tavily API）
- 可扩展的工具注册机制

### 4. 持久化
- 会话历史 JSONL 存储
- 记忆向量持久化
- 自动保存/恢复

## 代码中调用

```typescript
import { createLLMClient, Provider } from './llm/index.js';
import { runAgent } from './agent/index.js';
import { registry, registerTool } from './tools/registry.js';
import { calculatorTool } from './tools/calculator.js';

const llmClient = createLLMClient({
  provider: Provider.Ark,
  apiKey: process.env.ARK_API_KEY!,
});

registerTool(calculatorTool);

const result = await runAgent({
  prompt: 'Calculate 100 + 200',
  llmClient,
  toolRegistry: registry,
  maxIterations: 10,
});

console.log(result.response);
```

## 飞书 CLI

项目集成了 [@larksuite/cli](https://github.com/larksuite/cli)，提供完整的飞书 API 命令行支持。

### 主要功能

| 业务域 | 能力 |
|--------|------|
| 📅 日历 | 查看日程、创建日程、邀请参会人、查询忙闲状态 |
| 💬 即时通讯 | 发送/回复消息、创建和管理群聊、搜索消息 |
| 📄 云文档 | 创建、读取、更新、搜索文档 |
| 📁 云空间 | 上传和下载文件、管理权限与评论 |
| 📊 多维表格 | 创建和管理多维表格、字段、记录、视图 |
| 📈 电子表格 | 创建、读取、写入、追加、导出表格数据 |
| ✅ 任务 | 创建、查询、更新、完成任务 |
| 📚 知识库 | 创建和管理知识空间、节点和文档 |
| 👤 通讯录 | 按姓名/邮箱/手机号搜索用户 |
| 📧 邮箱 | 浏览、搜索、阅读邮件，发送、回复、转发 |
| 🎥 视频会议 | 搜索会议记录、查询会议纪要 |

### 快速配置

```bash
# 1. 初始化配置
npm run feishu:config

# 2. 登录授权（推荐使用）
npm run feishu:login

# 3. 验证配置
npm run feishu:status
```

### 常用命令

```bash
# 查看帮助
npx lark-cli --help

# 查看文档列表
npx lark-cli doc list

# 创建文档
npx lark-cli doc create --title "我的文档"

# 发送消息
npx lark-cli im send --chat-id oc_xxxx --content "Hello"

# 创建日程
npx lark-cli calendar +event --title "会议"
```

### 使用内置的 npm 脚本

| 脚本 | 说明 |
|------|------|
| `npm run feishu:config` | 初始化配置 |
| `npm run feishu:login` | 交互式登录授权 |
| `npm run feishu:status` | 查看登录状态 |
| `npm run feishu:doc` | 打开文档帮助 |

### AI Agent Skills

`@larksuite/cli` 还提供了 AI Agent Skills，让 AI 能够更好地操作飞书：

| Skill | 说明 |
|-------|------|
| `lark-shared` | 应用配置、认证登录、身份切换 |
| `lark-calendar` | 日历日程、忙闲查询 |
| `lark-im` | 发送/回复消息、群聊管理 |
| `lark-doc` | 创建、读取、更新、搜索文档 |
| `lark-drive` | 上传、下载文件 |
| `lark-sheets` | 电子表格操作 |
| `lark-base` | 多维表格操作 |
| `lark-task` | 任务管理 |
| `lark-wiki` | 知识库管理 |
