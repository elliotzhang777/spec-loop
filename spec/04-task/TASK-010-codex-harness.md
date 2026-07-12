# TASK-010：Codex Harness

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 依赖工单：TASK-009

## 目标

实现 prepare/execute/collect/verify/report，Codex 完成一个批准步骤，spec-loop 重算 diff 和 Evidence。

## 验收标准

- [x] AC-1：每阶段结构化、可恢复、可审计。
- [x] AC-2：Agent 只在代码 worktree，控制文件位于 Project root。
- [x] AC-3：进程 exit、stdout/stderr 和 artifact 被记录。
- [x] AC-4：两个真实 Codex Dogfood Gate PASS，Heavy 独立验收。
