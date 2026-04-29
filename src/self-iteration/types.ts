// ─── Self-Iteration Type Definitions ────────────────────────────────────────

/**
 * 代码修改请求：从飞书/IM 消息解析后的结构化指令
 */
export interface CodeChangeRequest {
  intent: 'modify' | 'add' | 'delete' | 'rollback';
  targetFile: string;
  description: string;
  code?: string;
  rollbackTo?: string;
  operator: OperatorInfo;
  rawMessage: string;
}

export interface OperatorInfo {
  type: 'user' | 'agent' | 'watchdog';
  userId?: string;
  userName?: string;
}

/**
 * 修改结果
 */
export interface ModificationResult {
  success: boolean;
  branch: string;
  commitHash: string;
  tag?: string;
  error?: string;
  validationResults?: ValidationResults;
  duration: number;
}

export interface ValidationResults {
  tscPass: boolean;
  testPass: boolean;
  sandboxPass: boolean;
  errors: string[];
}

/**
 * 版本信息
 */
export interface VersionInfo {
  tag: string;
  hash: string;
  date: string;
  message: string;
}

/**
 * 修改流程的状态机
 */
export type ModificationState =
  | 'idle'
  | 'branch_created'
  | 'code_modified'
  | 'validation_started'
  | 'validation_passed'
  | 'merged'
  | 'build_started'
  | 'deployed'
  | 'failed'
  | 'rolled_back';

/**
 * 断点恢复用的 checkpoint
 */
export interface ModificationCheckpoint {
  id: string;
  state: ModificationState;
  request: CodeChangeRequest;
  branch?: string;
  commitHash?: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

/**
 * 审计日志条目
 */
export interface AuditEntry {
  id: string;
  timestamp: string;
  operator: OperatorInfo;
  action: 'modify' | 'rollback' | 'restart' | 'cleanup';
  request: {
    rawMessage: string;
    parsedIntent: string;
    targetFiles: string[];
  };
  result: {
    success: boolean;
    commitHash?: string;
    tag?: string;
    error?: string;
    validationResults?: ValidationResults;
  };
  duration: number;
}

/**
 * 风险评估结果
 */
export interface RiskAssessment {
  level: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
  requiresApproval: boolean;
}

/**
 * 修改策略配置
 */
export interface ModificationPolicy {
  /** 绝对禁止修改的路径 glob */
  immutablePaths: string[];
  /** 白名单模式：仅允许修改的路径 glob（空 = 不限制） */
  allowedPaths: string[];
  /** 单次修改的约束 */
  maxFilesPerChange: number;
  maxLinesPerFile: number;
  maxTotalDiffLines: number;
}
