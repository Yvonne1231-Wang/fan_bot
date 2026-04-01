import type { TaskAnalysis } from './types.js';
import { createDebug } from '../../utils/debug.js';

const debug = createDebug('agent:team:analyzer');

/**
 * 任务分析器
 */
export class TaskAnalyzer {
  /**
   * 分析任务特征
   */
  async analyzeTask(prompt: string): Promise<TaskAnalysis> {
    debug.info('Analyzing task: %s', prompt);

    const complexity = this.assessComplexity(prompt);
    const abilities = this.identifyRequiredAbilities(prompt);
    const steps = this.estimateSteps(prompt);
    const recommendTeam = this.shouldUseTeam(complexity, abilities, steps);

    const analysis: TaskAnalysis = {
      complexity,
      requiredAbilities: abilities,
      estimatedSteps: steps,
      recommendTeam,
    };

    debug.info('Analysis result: %O', analysis);
    return analysis;
  }

  /**
   * 评估任务复杂度
   */
  private assessComplexity(prompt: string): 'simple' | 'complex' {
    const complexityIndicators = [
      '并且',
      '然后',
      '接着',
      '之后',
      'and',
      'then',
      'after',
      '如果',
      '否则',
      '要是',
      'if',
      'else',
      'when',
      '分析',
      '优化',
      '重构',
      'analyze',
      'optimize',
      'refactor',
      '同时',
      '既要又要',
      'meanwhile',
      'both',
    ];

    for (const indicator of complexityIndicators) {
      if (prompt.includes(indicator)) {
        debug.debug('Complexity indicator found: %s', indicator);
        return 'complex';
      }
    }

    return 'simple';
  }

  /**
   * 识别所需能力
   */
  private identifyRequiredAbilities(prompt: string): string[] {
    const abilities = new Set<string>();

    const abilityKeywords: Record<string, string[]> = {
      coding: [
        '代码',
        '编程',
        '实现',
        '函数',
        '类',
        '接口',
        'code',
        'program',
        'implement',
        'function',
        'class',
      ],
      research: [
        '搜索',
        '查找',
        '研究',
        '调查',
        '分析',
        'search',
        'find',
        'research',
        'investigate',
      ],
      analysis: [
        '分析',
        '评估',
        '优化',
        '诊断',
        '审查',
        'analyze',
        'evaluate',
        'optimize',
        'diagnose',
      ],
      testing: [
        '测试',
        '验证',
        '检查',
        '断言',
        '用例',
        'test',
        'verify',
        'check',
        'assert',
      ],
      writing: [
        '写作',
        '文档',
        '注释',
        '说明',
        '描述',
        'write',
        'document',
        'comment',
        'describe',
      ],
    };

    for (const [ability, keywords] of Object.entries(abilityKeywords)) {
      for (const keyword of keywords) {
        if (prompt.toLowerCase().includes(keyword.toLowerCase())) {
          abilities.add(ability);
          break;
        }
      }
    }

    return Array.from(abilities);
  }

  /**
   * 评估所需步骤数
   */
  private estimateSteps(prompt: string): number {
    const separators = /[,，。；;]|\b(and|then|after)\b/;
    const segments = prompt.split(separators).filter(Boolean);

    const verbs = [
      '创建',
      '实现',
      '编写',
      '修改',
      '删除',
      '更新',
      '添加',
      'create',
      'implement',
      'write',
      'modify',
      'delete',
      'update',
      'add',
    ];
    let verbCount = 0;
    for (const verb of verbs) {
      const matches = prompt.match(new RegExp(verb, 'gi'));
      if (matches) {
        verbCount += matches.length;
      }
    }

    return Math.max(segments.length, verbCount);
  }

  /**
   * 判断是否应该使用团队
   */
  private shouldUseTeam(
    complexity: 'simple' | 'complex',
    abilities: string[],
    steps: number,
  ): boolean {
    return complexity === 'complex' || abilities.length > 2 || steps > 3;
  }
}
