import { describe, it, expect } from 'vitest';
import { shouldPlan } from './planner.js';

describe('agent/planner shouldPlan', () => {
  describe('显式触发', () => {
    it('/plan 前缀始终触发', () => {
      expect(shouldPlan('/plan 帮我做三件事')).toBe(true);
    });
  });

  describe('中文误触发防护', () => {
    it('短中文消息不触发', () => {
      expect(shouldPlan('今天午餐有什么新品')).toBe(false);
    });

    it('包含「第一」的日常用语不触发', () => {
      expect(shouldPlan('我觉得第一印象很重要，你怎么看？这个话题值得深入讨论一下')).toBe(false);
    });

    it('包含「第一次」的叙述不触发', () => {
      expect(shouldPlan('这是我第一次来这个城市旅游，感觉非常新鲜有趣')).toBe(false);
    });

    it('简单两步操作不触发', () => {
      expect(shouldPlan('先帮我搜索一下最新新闻，然后告诉我重点')).toBe(false);
    });

    it('普通中文问句不触发', () => {
      expect(shouldPlan('帮我看看今天有什么重要的消息需要处理')).toBe(false);
    });
  });

  describe('应当触发的多步任务', () => {
    it('编号列表触发', () => {
      expect(shouldPlan('请帮我完成以下任务：\n1. 搜索最新的技术文章\n2. 整理成摘要\n3. 发送到群里')).toBe(true);
    });

    it('全角编号列表触发', () => {
      expect(shouldPlan('帮我做以下几件事：\n１、查找会议室预约情况\n２、给团队发通知')).toBe(true);
    });

    it('步骤关键词触发', () => {
      expect(shouldPlan('请按步骤1检查代码质量，步骤2运行测试，步骤3部署上线')).toBe(true);
    });

    it('多个序数词+动作触发', () => {
      expect(shouldPlan('第一，搜集所有相关资料并整理成表格；第二，分析数据趋势并输出报告；第三，发送给负责人审核')).toBe(true);
    });

    it('三段连续动作触发', () => {
      expect(shouldPlan('先帮我查一下今天的会议安排，然后把会议纪要整理成文档，最后发给团队所有成员')).toBe(true);
    });

    it('显式计划关键词触发', () => {
      expect(shouldPlan('请分步骤进行：先做调研然后做开发最后上线部署')).toBe(true);
    });

    it('分阶段关键词触发', () => {
      expect(shouldPlan('这个项目需要分阶段完成，每个阶段都有不同的交付物')).toBe(true);
    });

    it('英文 step 关键词触发', () => {
      expect(shouldPlan('Please follow this plan: step 1 research, step 2 implement, step 3 test')).toBe(true);
    });
  });

  describe('边界情况', () => {
    it('空字符串不触发', () => {
      expect(shouldPlan('')).toBe(false);
    });

    it('仅有 /plan 不触发（无实际内容）', () => {
      expect(shouldPlan('/plan')).toBe(false);
    });

    it('单个序数词不触发', () => {
      expect(shouldPlan('第一步我们需要先了解整个项目的背景信息和技术栈')).toBe(false);
    });
  });
});
