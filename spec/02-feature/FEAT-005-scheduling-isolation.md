# FEAT-005：Scheduling、隔离与安全控制

- 状态：草稿
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-12
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
5. Connector 按只读→评论/标签→有限状态更新逐级授权。
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
| Design | [DES-005 Scheduling、Worktree 与资源协调](../03-design/DES-005-scheduling-worktree-coordination.md) | 草稿 |
| Task | 待 Phase 4 进入条件满足 | 草稿 |

## 实际交付

- 已实现行为：无。
- 验证结论：待验证。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 融合 Scheduling、多任务和安全控制 | 最终 Roadmap 定稿 | - |

