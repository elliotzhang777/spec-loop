# TASK-042：v2 Controlled V 自动冻结 Harness 候选

- 状态：待验证
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-19
- 最后更新：2026-09-19
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-030、TASK-032 实现候选
- 任务等级：Light
- 协议版本：P/M/V/R v2
- 所属批次：目标工程接入修复

## 目标

让 `acceptance v-run` 在 v2 `plan_compiled` 阶段自动为当前干净候选生成 Harness collect 指纹，不再要求调用方额外运行旧 v1 Harness Maker 流程。

## 工作范围

### 包含

- Controlled V 执行 Gate 前读取当前 worktree HEAD、状态、diff 和内容指纹；
- 候选必须干净，并与 Workspace manifest 绑定；
- 缺失 Harness state 时直接生成 `collected` 状态和哈希证据；
- 同一候选已有 `collected` 状态时幂等复用，后续正式重试可重新冻结。

### 不包含

- 跳过 Acceptance Plan 的 HEAD、diff、worktree fingerprint 或 Gate Plan 校验；
- 运行额外 Maker Provider；
- 改变 V/R 判定、预算或 Evidence 要求。

## 验收标准

- [x] AC-1：v2 Task 没有旧 Harness state 时，`runControlledV` 可冻结干净候选并执行 Gate。
- [x] AC-2：冻结 Evidence 包含 HEAD、base commit、工作树状态、diff 和内容指纹哈希。
- [x] AC-3：脏工作树或不匹配候选继续 fail closed。
- [x] AC-4：TypeScript 构建与 acceptance-loop 定向测试通过。

## 验证范围

- `scope_kind: task`，`coverage: targeted`。
- 本轮只做实现与快速反馈；正式独立 V/R 仍按目标 Task 的单独授权执行。

## 交付记录

- 完成日期：2026-09-19，实现候选待正式验证。
- 变更文件/交付物：`src/execution.ts`、`src/acceptance-loop.ts`、`test/acceptance-loop.test.mjs`。
- 快速反馈：`npm run build` 通过；`node --test test/acceptance-loop.test.mjs` 19/19 通过。
- 关键实现：Controlled V 在干净 worktree 上原子写入 collect Evidence 与 Harness state；已有同一 collected 候选幂等复用，未完成旧 Harness 阶段 fail closed。
- 遗留风险：正式独立 V/R 尚未授权。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-19 | 创建并开始实施 | 海工 TASK-001 首次正式 V 在 Gate 执行前因缺失 Harness state 失败 |
| 2026-09-19 | 实现候选进入待验证 | 构建与 19 项 acceptance-loop 定向回归通过，等待独立正式 V/R |
