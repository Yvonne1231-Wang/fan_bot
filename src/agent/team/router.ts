import type { TaskAnalysis } from './types.js';
import { createDebug } from '../../utils/debug.js';

const debug = createDebug('agent:team:router');

/**
 * 路由规则接口
 */
interface RoutingRule {
  condition: (analysis: TaskAnalysis) => boolean;
  route: 'single' | 'team';
  priority: number;
}

/**
 * 路由配置接口
 */
interface RouterConfig {
  forceTeam?: boolean;
  forceSingle?: boolean;
  thresholds?: {
    maxSingleSteps: number;
    maxSingleAbilities: number;
  };
}

/**
 * 任务路由器
 */
export class TaskRouter {
  private rules: RoutingRule[] = [];
  private config: RouterConfig;

  constructor(config: RouterConfig = {}) {
    this.config = config;
    this.initDefaultRules();
  }

  /**
   * 初始化默认路由规则
   */
  private initDefaultRules() {
    this.addRule({
      condition: (analysis) =>
        analysis.complexity === 'simple' &&
        analysis.requiredAbilities.length === 1 &&
        analysis.estimatedSteps === 1,
      route: 'single',
      priority: 100,
    });

    this.addRule({
      condition: (analysis) =>
        analysis.complexity === 'complex' &&
        analysis.requiredAbilities.length > 2,
      route: 'team',
      priority: 90,
    });

    const maxSteps = this.config.thresholds?.maxSingleSteps ?? 3;
    this.addRule({
      condition: (analysis) => analysis.estimatedSteps > maxSteps,
      route: 'team',
      priority: 80,
    });

    const maxAbilities = this.config.thresholds?.maxSingleAbilities ?? 2;
    this.addRule({
      condition: (analysis) => analysis.requiredAbilities.length > maxAbilities,
      route: 'team',
      priority: 70,
    });

    this.addRule({
      condition: () => true,
      route: 'single',
      priority: 0,
    });
  }

  /**
   * 添加路由规则
   */
  addRule(rule: RoutingRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 决定路由方式
   */
  async determineRoute(analysis: TaskAnalysis): Promise<'single' | 'team'> {
    debug.info('Determining route for analysis: %O', analysis);

    if (this.config.forceTeam) {
      debug.info('Force team mode enabled');
      return 'team';
    }
    if (this.config.forceSingle) {
      debug.info('Force single mode enabled');
      return 'single';
    }

    for (const rule of this.rules) {
      if (rule.condition(analysis)) {
        debug.info(
          'Rule matched with priority %d: %s',
          rule.priority,
          rule.route,
        );
        return rule.route;
      }
    }

    debug.info('No rule matched, using default route: single');
    return 'single';
  }

  /**
   * 更新路由配置
   */
  updateConfig(config: Partial<RouterConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };

    this.rules = [];
    this.initDefaultRules();
  }
}
