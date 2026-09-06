# TASK-009：Git worktree 与 T1 通用 Gate

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 最后更新：2026-09-04
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

## 交付与验证结论

- TASK-013 已在 Phase 3 最终候选 `3b05ac59a5d14b21486362ab4179f053eedc6ffb` 上完成 WPHASE3 full Harness、67 项回归、独立 Verifier 和用户 Heavy 验收。
- 最终交付覆盖独立 worktree/branch、base/HEAD/diff/touched files、受控 Gate、artifact hash、禁止发布副作用与故障恢复，完整包含本工单 AC-1～AC-4。
- 正式证据见[阶段三交付报告](../05-delivery/阶段三交付报告.md)和 [TASK-013](TASK-013-phase3-hardening-acceptance.md)。

## 关闭检查

- [x] 验收标准全部通过
- [x] Phase 3 最终 Heavy Evidence 已覆盖
- [x] 上游 FEAT-003/DES-003 已标记完成
- [x] 已从临时看板移除

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 将历史“待验证”纠正为“已完成” | TASK-013 已正式覆盖本工单全部 AC，原状态未随 Phase 3 收口同步 |
