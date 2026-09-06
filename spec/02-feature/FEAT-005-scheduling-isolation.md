# FEAT-005：Scheduling、隔离与安全控制

- 状态：已批准
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-09-04
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 所属阶段：Phase 4

## 用户价值

作为多任务用户，我希望系统能定时发现工作、隔离自动修改、检测资源冲突并随时暂停，同时不越过 Connector 和生产权限边界。

## 行为说明

初期 Scheduler 只报告；批准后任务在 worktree 中受控执行。Project/task lease、fencing token、resource claim、预算、Denylist、Pause/Kill 和审计共同约束自动化。

## 业务规则

1. report-only 稳定前不得自动创建或执行 Task。
2. 所有自动代码修改必须使用 worktree、branch、base commit 和 touched files 记录。
3. 无冲突任务可并发，冲突写资源必须串行。
4. Pause 阻止新动作；Kill 取消执行、保留现场并要求 reconcile。
5. Connector 按只读→评论/标签→有限状态更新逐级授权；首个双向实现为 [FEAT-008 飞书正式机器人](FEAT-008-feishu-progress-approval-connector.md)，远程决定仍必须经过本地 Guard。
6. 默认禁止 merge、删除、生产数据、凭据和发布动作。

## 验收标准

- AC-1：Scheduler report-only 试运行可衡量。
- AC-2：所有自动代码修改隔离且可清理/恢复。
- AC-3：冲突检测、Lease 和 fencing 阻止双写。
- AC-4：Pause/Kill 立即阻止后续动作并保留证据。
- AC-5：Connector 最小权限和 Denylist 对抗测试通过。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-005 Scheduling、Worktree 与资源协调](../03-design/DES-005-scheduling-worktree-coordination.md) | 已批准 |
| Task | [TASK-034 Report-only Scheduler](../04-task/TASK-034-report-only-scheduler.md) | 已批准 |
| Task | [TASK-035 Lease、资源协调与 Pause/Kill](../04-task/TASK-035-scheduler-leases-controls.md) | 已批准 |
| Task | [TASK-037 Phase 4 最终 Heavy](../04-task/TASK-037-phase4-pmvr-heavy-dogfood.md) | 已批准 |

## 实际交付

- 已实现行为：已有 TASK-030 的 Ready/blocked、Conflict/Inbox 调度投影；真实 Scheduler、lease 和 Worker 控制尚未实现。
- 验证结论：TASK-034/035 已按 P/M/V/R v2 批准，等待前置依赖。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 融合 Scheduling、多任务和安全控制 | 最终 Roadmap 定稿 | - |
| 2026-08-04 | 将飞书正式机器人下沉为独立 Feature | 通用 Connector 规则不足以表达远程身份、卡片确认和恢复契约 | TASK-021～026 |
| 2026-09-04 | 批准 report-only 与受控执行两段实施 | 先证明报告质量，再开放 lease 约束下的自动动作 | TASK-034、TASK-035、TASK-037 |
