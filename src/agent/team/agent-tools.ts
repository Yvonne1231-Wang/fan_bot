/**
 * Agent 专属工具集
 *
 * 为不同类型的 Agent 提供专属的工具集合
 */

import type { Tool, ToolRegistry } from '../../tools/types.js';
import { readFileTool, writeFileTool, listDirTool } from '../../tools/files.js';
import { shellTool } from '../../tools/shell.js';
import { webSearchTool } from '../../tools/web_search.js';
import { webFetchTool } from '../../tools/web_fetch.js';
import { calculatorTool } from '../../tools/calculator.js';

/**
 * 简单的工具注册表实现
 */
class SimpleToolRegistry implements ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.schema.name, tool);
  }

  getSchemas() {
    return Array.from(this.tools.values()).map((t) => t.schema);
  }

  async dispatch(
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found`);
    }
    return tool.handler(input);
  }

  async dispatchWithConfirmation(
    name: string,
    input: Record<string, unknown>,
    confirmFn?: (preview: string) => Promise<boolean>,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found`);
    }

    if (tool.requiresConfirmation && confirmFn) {
      const preview = `${name}(${JSON.stringify(input)})`;
      const approved = await confirmFn(preview);
      if (!approved) return 'Tool execution cancelled by user.';
    }

    return this.dispatch(name, input);
  }
}

/**
 * 创建新的工具注册表
 */
function createToolRegistry(): ToolRegistry {
  return new SimpleToolRegistry();
}

/**
 * 编码 Agent 工具集
 * - 文件读写
 * - Shell 命令
 * - 目录浏览
 */
export function createCoderToolRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(listDirTool);
  registry.register(shellTool);
  registry.register(calculatorTool);
  return registry;
}

/**
 * 研究 Agent 工具集
 * - 网络搜索
 * - 网页抓取
 */
export function createResearcherToolRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(webSearchTool);
  registry.register(webFetchTool);
  return registry;
}

/**
 * 分析 Agent 工具集
 * - 文件读取
 * - 目录浏览
 * - Shell 命令（用于运行分析工具）
 */
export function createAnalyzerToolRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(readFileTool);
  registry.register(listDirTool);
  registry.register(shellTool);
  return registry;
}

/**
 * 测试 Agent 工具集
 * - 文件读写
 * - Shell 命令（运行测试）
 */
export function createTesterToolRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(shellTool);
  return registry;
}

/**
 * 文档 Agent 工具集
 * - 文件读写
 * - 目录浏览
 */
export function createDocumenterToolRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(listDirTool);
  return registry;
}

/**
 * 协调者 Agent 工具集
 * - 基础工具
 */
export function createCoordinatorToolRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(calculatorTool);
  return registry;
}

/**
 * 全能 Agent 工具集
 * - 所有工具
 */
export function createFullToolRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(listDirTool);
  registry.register(shellTool);
  registry.register(webSearchTool);
  registry.register(webFetchTool);
  registry.register(calculatorTool);
  return registry;
}

/**
 * Agent 类型到工具注册表工厂的映射
 */
export const AGENT_TOOL_REGISTRIES: Record<string, () => ToolRegistry> = {
  coordinator: createCoordinatorToolRegistry,
  coder: createCoderToolRegistry,
  researcher: createResearcherToolRegistry,
  analyzer: createAnalyzerToolRegistry,
  tester: createTesterToolRegistry,
  documenter: createDocumenterToolRegistry,
  full: createFullToolRegistry,
};

/**
 * 获取 Agent 工具注册表
 */
export function getAgentToolRegistry(agentType: string): ToolRegistry {
  const factory = AGENT_TOOL_REGISTRIES[agentType];
  if (factory) {
    return factory();
  }
  return createFullToolRegistry();
}
