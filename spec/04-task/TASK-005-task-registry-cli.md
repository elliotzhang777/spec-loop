# TASK-005：Task Registry 与查询 CLI

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 依赖工单：TASK-004

## 目标

扫描 Task 目录并支持 list/show/resumable，不建立第二状态源。

## 验收标准

- [x] AC-1：支持按 project/state 查询和 show/resumable。
- [x] AC-2：Registry 每次从 Task 目录重建，不持久化第二状态。
- [x] AC-3：重复 ID 和坏 Task 严格失败。

## 交付记录

- CLI：`tasks list/show/resumable`。
- 验证：Project E2E 测试。
