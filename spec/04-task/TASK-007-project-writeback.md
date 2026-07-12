# TASK-007：Delivery 项目回写摘要

- 状态：已完成
- 优先级：P1
- 负责人：Codex
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 依赖工单：TASK-005

## 目标

从 delivered Task 生成 Project State/外部 Issue 待回写摘要，不直接写外部系统。

## 验收标准

- [x] AC-1：摘要只使用 Task/Delivery/Evidence 事实。
- [x] AC-2：重复生成幂等覆盖同一输出。
- [x] AC-3：不复制 Task State 为项目权威状态。
