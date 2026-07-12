# TASK-003：Phase 3 Project Loop（Heavy 主工单）

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 任务等级：Heavy
- 依赖工单：TASK-004～012

## 目标

实现 Project Control Plane 与 Codex 受控单步执行，使一个项目能管理多个 Task，并在 worktree 中完成可验证的真实工程步骤。

## 工作范围

### 包含

- Project metadata/State、目标工程规格库、Registry、查询、Triage/Approval、write-back；
- Provider 配置、worktree、T1 Gate、Codex Harness；
- 两个真实项目 Dogfood、独立验证和正式 Delivery。

### 不包含

- Scheduling、自动多 Round、多任务并发、push/merge、Connector 写入。

## 验收标准

- [x] AC-1：项目和任务可严格注册、查询、恢复和重建。
- [x] AC-2：Proposal 未批准不能成为正式 Task。
- [x] AC-3：Codex 在 worktree 完成真实任务，Evidence 绑定 HEAD。
- [x] AC-4：Delivery 生成 Project 回写摘要。
- [x] AC-5：两个真实项目 Dogfood delivered。
- [x] AC-6：Phase 1–3 全量测试和独立 Verifier PASS。
- [x] AC-7：每个目标工程具备可补建、可校验且不覆盖已有内容的分层规格库。

## 验证计划

| 验收标准 | 验证方法 | 预期结果 |
|---|---|---|
| AC-1～4 | 自动化、E2E、对抗和恢复测试 | 全部通过 |
| AC-3～5 | 两个真实项目 Dogfood | delivered |
| AC-6 | `npm test` + 独立 Heavy 验收 | PASS |

## 风险

- Agent 越权、Registry 状态分叉、worktree 污染、外部 CLI 差异、错误 Evidence revision。

## 交付记录

- 完成日期：2026-07-12
- 交付物：Project/目标工程规格库/Registry/Triage/Provider/Worktree/Gate/Harness/Writeback、测试和两个 Project Dogfood。
- 遗留风险：Claude Code/Qoder 未真实 Dogfood；完整 worktree GC 后续补强。

## 关闭检查

- [x] 子工单全部完成
- [x] 全部 AC 有当前 Evidence
- [x] 两个 Dogfood delivered
- [x] 独立 Verifier 和人工检查通过
- [x] 上游规格和看板已同步
