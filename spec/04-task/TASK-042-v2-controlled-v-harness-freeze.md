# TASK-042：v2 Controlled V 自动冻结 Harness 候选

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-19
- 最后更新：2026-09-29
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
- 当前执行约定允许已批准 Task 内连续完成定向 V/R；候选变化重新绑定证据。

## 交付记录

- 完成日期：2026-09-29；候选 `eca847d` 独立 Light V/R 双 PASS。
- 变更文件/交付物：`src/execution.ts`、`src/acceptance-loop.ts`、`test/acceptance-loop.test.mjs`。
- 快速反馈：`npm run build` 通过；`node --test test/acceptance-loop.test.mjs` 19/19 通过。
- 关键实现：Controlled V 在干净 worktree 上原子写入 collect Evidence 与 Harness state；已有同一 collected 候选幂等复用，未完成旧 Harness 阶段 fail closed。
- 正式证据：`.spec-loop/output/TASK-042-{V,R}-eca847d.json`。当前 HEAD Controlled V 定向 1/1 与独立临时批准工程证明自动 collect、完整指纹绑定和同候选字节幂等；脏树、Workspace mismatch、旧 prepared/executed 均 fail closed。同 HEAD 构建及 acceptance-loop 34/34 复用 TASK-040 Gate。
- 遗留风险：本工单未运行真实 M 或最终 Heavy；这些仍由对应任务的权限与预算控制。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-19 | 创建并开始实施 | 海工 TASK-001 首次正式 V 在 Gate 执行前因缺失 Harness state 失败 |
| 2026-09-19 | 实现候选进入待验证 | 构建与 19 项 acceptance-loop 定向回归通过，等待独立正式 V/R |
| 2026-09-29 | 完成独立 Light V/R 并关闭工单 | AC-1～4 全通过，自动冻结与候选绑定均可复核 |
