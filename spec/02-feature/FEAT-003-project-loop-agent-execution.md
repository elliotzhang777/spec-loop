# FEAT-003：Project Loop 与 Agent 受控执行

- 状态：待验证
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-15
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 所属阶段：Phase 3

## 用户价值

作为用户，我希望在一个工程中管理多个任务、手动发现候选工作，并让 Codex 在隔离环境完成明确批准的步骤，从而从单任务文件升级为可运行的 Project Loop。

## 行为说明

Project metadata 和 Project State 提供项目上下文；Task Registry 从任务目录重建；Triage 只产生 Proposal；批准后创建正式 Task。Codex Harness 在 worktree 执行 `prepare → execute → collect → verify → report`。Phase 3 多任务可管理但默认串行。

## 业务规则

1. Registry 是可重建索引，不得覆盖 Task State。
2. Project State 原生保存目标、候选、忽略原因和下一步；活跃/阻塞/Delivery 从 Task 派生。
3. 未批准 Proposal 不能成为 Task；批准绑定 Proposal/Spec hash、范围和风险。
4. 初始 Provider 为 Codex、Claude Code、Qoder，默认 Codex；真实 Dogfood 首先要求 Codex。
5. 真实代码修改必须使用独立 worktree/branch，禁止 push/merge。
6. T1 Gate 生成绑定真实 HEAD 的 Evidence。
7. Phase 3 不做 Scheduling、并发 Worker 或自动 Round Controller。
8. 每个 Project 的目标仓库必须维护独立 `spec/` 规格库；初始化不得覆盖已有规格文件，缺失结构必须能补建和校验；正式 Task 必须同步生成目标工程 Task 规格，或在显式操作且内容一致时接管已批准的草稿规格。
9. Controller 必须区分快速反馈检查、候选版本检查和正式交付 Gate；低风险反馈默认只运行受影响检查，用户确认后才对稳定候选统一执行完整 Harness。验证范围和升级原因必须记录。

## 验收标准

- AC-1：按状态、项目和 resumable 查询多个任务。
- AC-2：Registry 可删除重建且不产生第二套状态。
- AC-3：Triage Proposal 未批准时不能创建 Task。
- AC-4：Codex 在 worktree 完成真实任务并生成 HEAD Evidence。
- AC-5：Delivery 生成 Project 回写摘要但不写外部系统。
- AC-6：两个真实项目 Dogfood delivered，独立 Verifier PASS。
- AC-7：Project 初始化会建立目标工程规格库，`project spec-check` 对缺失或空文件严格失败。
- AC-8：同一 Task 的低风险反馈不会机械重跑历史 Task Gate；正式 Delivery 仍保留完整验证且 Evidence 绑定最终 HEAD。

## 非功能要求

- 安全：Provider 不直接修改控制文件；无 push/merge/Connector write。
- 可恢复：Project/Registry/Harness 中断后可 reconcile。
- 可观测：记录 Provider、worktree、base/HEAD、命令和 artifact。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-003 Project Control Plane 与 Agent Harness](../03-design/DES-003-project-loop-agent-harness.md) | 待验证 |
| Task | [TASK-003 Phase 3 Heavy 主工单](../04-task/TASK-003-phase3-project-loop.md)、TASK-004～TASK-012、[TASK-013](../04-task/TASK-013-phase3-hardening-acceptance.md)、[TASK-016](../04-task/TASK-016-define-verification-scope.md)、[TASK-017](../04-task/TASK-017.md) | 进行中 |

## 实际交付

- 已实现行为：Project/Registry/Triage/Approval、由随包版本清单驱动的目标工程规格库、Provider config、worktree、T1 Gate、Codex Harness 和 write-back。
- 未实现/调整项：多任务仍串行；Claude Code/Qoder 未做真实 Dogfood；Phase 3 由 Controller 人工选择反馈检查范围，自动影响分析和 Gate Planner 留给 Phase 4 Toolchain。
- 验证结论：原型 Dogfood 已完成；加固版本等待独立 Verifier、Heavy 人工检查和重新签署正式 Delivery。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 融合 Project Loop 与执行基础 | 最终 Roadmap 定稿 | - |
| 2026-07-15 | 增加反馈检查与正式 Gate 分层 | 避免低风险改动重复运行完整交付闭环 | TASK-016 |
| 2026-07-19 | 统一目标规格模板事实源 | 自托管检查发现内联模板漂移、缺少 Architecture 和检查规则误报 | TASK-017 |
