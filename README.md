# Fan Bot

一个轻量级、无框架的 TypeScript AI Agent，支持多 Provider（Anthropic Claude、Ark）和工具调用。

## 项目结构

```
fan_bot/
├── src/
│   ├── agent/           # Agent 核心逻辑
│   │   ├── loop.ts      # 主循环：调用 LLM、处理工具调用
│   │   └── smoke_test.ts # Agent 模块测试
│   ├── llm/             # LLM 客户端抽象层
│   │   ├── anthropic.ts # Anthropic Claude API 实现
│   │   ├── openai.ts    # OpenAI/Ark API 实现
│   │   └── types.ts     # 共享类型定义
│   ├── session/         # 会话持久化管理
│   │   ├── store.ts     # JSONL 文件存储
│   │   ├── manager.ts   # 会话管理器（加载/保存/裁剪）
│   │   └── smoke_test.ts # Session 模块测试
│   ├── tools/           # 工具注册与内置工具
│   │   ├── registry.ts  # 工具注册表
│   │   └── calculator.ts # 内置计算器
│   ├── transport/       # 传输层
│   │   ├── cli.ts       # 命令行交互模式
│   │   └── http.ts      # HTTP API 模式（预留）
│   ├── utils/
│   │   └── debug.ts     # 调试日志工具
│   └── index.ts         # 应用入口
├── dist/                # TypeScript 编译输出
└── sessions/            # 会话文件存储目录（运行时创建）
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

### 3. 启动 CLI

```bash
npm run cli
```

交互示例：

```
Agent CLI
Session: session-1234567890
Type "exit" to quit.

> 你好
你好！有什么我可以帮你的吗？

> 计算 123 + 456
123 + 456 = 579

> exit
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
| `llm:openai` | OpenAI/Ark API 调用 |
| `llm:anthropic` | Anthropic API 调用 |
| `session:manager` | 会话管理 |
| `tools:registry` | 工具注册 |

## 运行测试

```bash
# 运行 session 模块测试（不需要 API Key）
npx tsx src/session/smoke_test.ts

# 运行 agent 模块测试（需要 API Key）
npx tsx src/agent/smoke_test.ts

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
         calculator.ts (内置计算器)
```

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
