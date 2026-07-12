# TASK-008：Provider 配置与 Adapter 合同

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 依赖工单：TASK-004

## 目标

严格配置 Codex、Claude Code、Qoder，默认 Codex，并定义统一 inspect/invoke/cancel 合同。

## 验收标准

- [x] AC-1：未知 Provider/字段失败，active 必须 enabled。
- [x] AC-2：默认 Codex；缺失 CLI 返回诊断而不改状态。
- [x] AC-3：Provider 进程结果、超时/错误通过统一 Harness 边界处理。
