/**
 * Agent Team 模块导出
 */

// 核心类
export { AgentTeam } from './agent.js';
export { TaskAnalyzer } from './analyzer.js';
export { TaskRouter } from './router.js';

// 类型
export type {
  TeamAgent,
  TeamTask,
  TeamConfig,
  TeamMessage,
  TaskAnalysis,
  ResourceLimits,
  InstanceStatus,
  AgentExecutionResult,
} from './types.js';

// Agent 提示词
export {
  COORDINATOR_PROMPT,
  CODER_PROMPT,
  RESEARCHER_PROMPT,
  ANALYZER_PROMPT,
  TESTER_PROMPT,
  DOCUMENTER_PROMPT,
  AGENT_PROMPTS,
  getAgentPrompt,
} from './agent-prompts.js';

// Agent 工具集
export {
  createCoderToolRegistry,
  createResearcherToolRegistry,
  createAnalyzerToolRegistry,
  createTesterToolRegistry,
  createDocumenterToolRegistry,
  createCoordinatorToolRegistry,
  createFullToolRegistry,
  getAgentToolRegistry,
  AGENT_TOOL_REGISTRIES,
} from './agent-tools.js';

// 实例管理
export { AgentInstanceManager } from './instance/manager.js';
export type {
  AgentInstance,
  InstanceManagerConfig,
} from './instance/manager.js';
export { AgentInstancePool } from './instance/pool.js';
export { AgentLifecycleManager } from './instance/lifecycle.js';
