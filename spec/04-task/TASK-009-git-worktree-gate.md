# TASK-009：Git worktree 与 T1 通用 Gate

- 状态：待验证
- 优先级：P0
- 负责人：Codex
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 依赖工单：TASK-008

## 目标

为真实代码任务提供 worktree、branch、base/HEAD、diff 和受控命令 Evidence。

## 验收标准

- [x] AC-1：每任务独立 worktree/branch，不修改主工作区。
- [x] AC-2：Gate 记录 argv、cwd、timeout、exit、artifact hash 和 HEAD。
- [x] AC-3：Gate 禁止 push/merge/deploy/publish/release。
- [x] AC-4：脏 worktree保留现场，manifest 支持检查和恢复。
