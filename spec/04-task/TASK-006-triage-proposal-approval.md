# TASK-006：手动 Triage、Proposal 与 Approval

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 依赖工单：TASK-004

## 目标

实现只产生 Proposal 的手动 Triage 和 hash-bound 用户批准门禁。

## 验收标准

- [x] AC-1：Proposal 包含来源、目标、风险、优先级、初始 AC 和理由。
- [x] AC-2：未批准或内容 hash 变化 Proposal 不能创建 Task。
- [x] AC-3：Approval 记录身份、时间、范围和 hash。

## 交付记录

- CLI：`triage propose/approve/create-task`。
- 验证：未批准拒绝、批准后创建和 Registry 重建 E2E。
