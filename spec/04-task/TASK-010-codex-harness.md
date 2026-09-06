# TASK-010：Codex Harness

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 最后更新：2026-09-04
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

## 交付与验证结论

- TASK-013 已完成 `prepare → execute → collect → verify → report` 全链路 Heavy 验收，Harness Report 绑定 Task、worktree、base、HEAD、Gate artifact 与哈希。
- WPHASE3 full Harness、67 项回归、独立 Verifier 和用户 Heavy 验收均已通过，完整覆盖本工单 AC-1～AC-4。
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
