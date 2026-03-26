# Agent 改造计划

## 当前改造计划
详见 `docs/refactoring-plan.md`，按 Phase 顺序执行。
当前进度：Phase 1 进行中。

## 工作约定
- 每次修改前先读对应 task 的验收条件
- 改动 loop.ts 必须同步更新单测
- 不要跨 Phase 超前实现

```
## 执行规范：
1. 每次只做一个 task，完成后说明改了哪些文件
2. 做完 Phase 1 的所有 task 后等待确认，再继续 Phase 2
3. 修改前先读对应源文件，不要假设内容
4. bug 修复优先于新功能
5. 不要引入 package.json 里没有的新依赖，除非任务明确需要