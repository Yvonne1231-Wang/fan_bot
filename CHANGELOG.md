# Changelog

All notable changes to this project will be documented in this file.

---

## [Langfuse] - 2026-04-17

### Added
- **Langfuse 可观测性集成** - LLM 调用追踪、成本分析、调试可视化
  - 新增 `src/observability/` 模块，封装 Langfuse SDK 初始化与 Trace/Span/Generation 管理
  - Agent Loop 中每次 LLM 调用自动创建 Generation，记录 input/output/token usage
  - Agent Loop 中每次工具调用自动创建 Span，记录工具名、输入输出
  - Handler 层自动创建 Trace，关联 sessionId/userId
  - 未配置密钥时静默跳过，零开销
- **自部署方案** - `docker-compose.langfuse.yml` + `scripts/langfuse-keys.sh`
  - 一键启动 Langfuse v3（PostgreSQL + Redis + ClickHouse + MinIO）
  - 密钥自动生成脚本
  - 数据完全在内网，不出外网

### Changed
- `RunAgentOptions` 新增可选 `trace` 参数，向后兼容
- `.env.example` 新增 Langfuse 配置项说明
- `.gitignore` 新增 `.env.langfuse` 排除

---

## Memory System

- **混合检索** - 向量搜索 + BM25 混合模式
- **真 BM25** - Okapi BM25 算法，含 IDF 权重和文档长度归一化
- **Cross-Encoder Reranking** - Jina rerank API 支持，结果重排序
- **自适应检索门控** - 智能判断是否需要查记忆
- **自动记忆提取** - 从对话中自动提取关键信息
- **用户隔离** - 记忆按用户隔离，互不干扰
- **上下文压缩** - 上下文过长时自动压缩
- **艾宾浩斯曲线** - 模仿人脑遗忘规律，新增 `memoryStrength` 字段，被访问的记忆强度恢复、衰减重置
- **记忆强化机制** - 频繁访问的记忆半衰期延长，最多延长到基础的 3 倍

---

## Core Features

- **多 Provider** - Anthropic Claude / 字节跳动 Ark（火山引擎）
- **多阶段 Agent** - 支持复杂任务的分解和执行
- **web_search** - 实时联网搜索能力
- **Sub-Agent 架构** - 任务路由到专用子 Agent（Vision/Web Researcher/Coder）

---

## Media Understanding

- **图片理解** - describe_image tool，多格式支持（JPG/PNG/WebP/GIF）
- **音频转写** - whisper 音频转文字（没模型）

---

## Feishu Integration

- **消息系统** - 消息接收、回复、卡片消息、流式输出
- **Skills 生态** - 飞书专属技能集（创建文档、搜索内容等）
- **权限管理** - 群组/DM 权限控制

---

## Cron & Tasks

- **定时任务调度** - agent / notification / shell 三种任务类型
- **签名验证** - 安全机制
- **主动推送** - 定时任务结果发送到指定飞书聊天

---

## Base Infrastructure

- **Agent 核心** - 轻量级，无框架，纯 TypeScript
- **会话持久化** - JSONL 文件存储，自动压缩
- **多渠道适配器** - CLI / HTTP / Feishu
