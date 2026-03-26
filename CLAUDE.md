# Agent 改造计划

## 当前改造计划
详见 `docs/refactoring-plan.md`，按 Phase 顺序执行。
当前进度：Phase 1 进行中。

## 工作约定
- 每次修改前先读对应 task 的验收条件
- 改动 loop.ts 必须同步更新单测
- 不要跨 Phase 超前实现
```

**`docs/refactoring-plan.md`**

然后告诉 agent：
```
请阅读 docs/refactoring-plan.md，从 Phase 1 的 task 1.1 开始实施。
每完成一个 task 的验收条件，在文件里勾选对应的 checkbox，再进行下一个。