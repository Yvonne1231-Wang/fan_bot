import type { LLMClient, ToolSchema } from '../../llm/types.js';
import type { MemoryService } from '../../memory/types.js';
import type { ToolRegistry } from '../../tools/types.js';

/**
 * Team Agent 类型定义
 */
export interface TeamAgent {
  /** Agent 类型标识 */
  type: string;

  /** Agent 名称 */
  name: string;

  /** Agent 具备的能力列表 */
  abilities: string[];

  /** Agent 可用的工具 Schema 列表 */
  tools: ToolSchema[];

  /** Agent 专属系统提示词 */
  systemPrompt: string;

  /** Agent 工具注册表（实际执行工具） */
  toolRegistry?: ToolRegistry;

  /** Agent 工作目录 */
  workspace?: string;

  /** Agent 独立的 LLM 客户端（可选） */
  llmClient?: LLMClient;

  /** Agent 使用的模型（可选） */
  model?: string;

  /** 是否为 Lead Agent（负责整合结果） */
  isLead?: boolean;
}

/**
 * Team Task 类型定义
 */
export interface TeamTask {
  /** 任务唯一标识 */
  id: string;

  /** 任务名称（用于依赖引用） */
  name?: string;

  /** 任务描述 */
  description: string;

  /** 任务执行者 */
  assignee: TeamAgent | null;

  /** 任务状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'error';

  /** 任务结果 */
  result?: string;

  /** 任务依赖的其他任务 ID */
  dependencies?: string[];

  /** 任务依赖的其他任务名称（用于解析） */
  depNames?: string[];

  /** 任务输入数据（来自其他任务） */
  input?: Record<string, unknown>;

  /** 任务优先级 */
  priority?: number;

  /** LLM 建议的 Agent 类型 */
  suggestedAgentType?: string;
}

/**
 * Team Config 类型定义
 */
export interface TeamConfig {
  /** 是否启用团队模式 */
  enableTeam: boolean;

  /** 协调者 Agent */
  coordinator?: TeamAgent;

  /** Lead Agent（负责整合结果） */
  lead?: TeamAgent;

  /** 团队成员 */
  teammates?: TeamAgent[];

  /** 工作目录 */
  workDir?: string;

  /** LLM 客户端 */
  llmClient?: LLMClient;

  /** 内存服务 */
  memory?: MemoryService;

  /** 共享上下文（Agent 间传递数据） */
  sharedContext?: Record<string, unknown>;

  /** 并发限制 */
  concurrency?: number;

  /** 默认模型 */
  defaultModel?: string;

  /** 中止信号（传递给 runAgent） */
  abortSignal?: AbortSignal;
}

/**
 * Team Message 类型定义 - Agent 间通信
 */
export interface TeamMessage {
  /** 消息 ID */
  id: string;

  /** 发送 Agent */
  fromAgent: string;

  /** 接收 Agent */
  toAgent: string;

  /** 相关任务 ID */
  taskId?: string;

  /** 消息类型 */
  type: 'result' | 'request' | 'status';

  /** 消息内容 */
  content: unknown;

  /** 时间戳 */
  timestamp: number;
}

/**
 * 子任务定义
 */
export interface SubTaskDefinition {
  /** 子任务名称 */
  name?: string;

  /** 子任务描述 */
  description: string;

  /** 所需能力 */
  requiredAbility: string;

  /** 建议的 Agent 类型 */
  suggestedAgent: string;

  /** 依赖的其他子任务名称 */
  dependencies?: string[];
}

/**
 * Task Analysis 类型定义
 */
export interface TaskAnalysis {
  /** 任务复杂度 */
  complexity: 'simple' | 'complex';

  /** 所需能力 */
  requiredAbilities: string[];

  /** 估计步骤数 */
  estimatedSteps: number;

  /** 是否建议使用团队 */
  recommendTeam: boolean;

  /** 建议的 Agent 类型 */
  suggestedAgents?: string[];

  /** 子任务列表 */
  subTasks?: SubTaskDefinition[];
}

/**
 * Resource Limits 类型定义
 */
export interface ResourceLimits {
  /** 最大实例数 */
  maxInstances: number;

  /** 每个实例最大内存 */
  maxMemoryPerInstance: number;

  /** 总内存限制 */
  maxTotalMemory: number;

  /** 最大并发任务数 */
  maxConcurrentTasks: number;
}

/**
 * Instance Status 类型定义
 */
export type InstanceStatus = 'idle' | 'busy' | 'error';

/**
 * Agent 执行结果
 */
export interface AgentExecutionResult {
  /** 关联的任务 ID */
  taskId?: string;

  /** Agent 类型 */
  agentType: string;

  /** 执行是否成功 */
  success: boolean;

  /** 输出结果 */
  output: string;

  /** 错误信息 */
  error?: string;

  /** 工具调用记录 */
  toolCalls?: Array<{
    tool: string;
    input: unknown;
    output: string;
  }>;
}

/**
 * 执行选项
 */
export interface ExecutionOptions {
  /** 并发限制 */
  concurrency?: number;

  /** 超时时间（毫秒） */
  timeout?: number;

  /** 是否显示进度 */
  showProgress?: boolean;

  /** 进度回调 */
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * 进度事件
 */
export interface ProgressEvent {
  /** 事件类型 */
  type: 'start' | 'complete' | 'error' | 'waiting';

  /** 任务 ID */
  taskId: string;

  /** 任务名称 */
  taskName?: string;

  /** Agent 名称 */
  agentName?: string;

  /** 消息 */
  message?: string;
}
