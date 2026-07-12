# DES-005：Scheduling、Worktree 与资源协调

- 状态：草稿
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属特性：[FEAT-005](../02-feature/FEAT-005-scheduling-isolation.md)

## 设计目标

在 report-only 试运行后安全调度批准任务，保证代码、项目运行、工具资源和 Connector 权限不会冲突或越界。

## 现状与约束

- 现状：Phase 3 已交付多任务管理、串行单步 Harness 和 worktree 隔离，但没有 Scheduler。
- 技术约束：依赖单步 worktree 和 Phase 4 Controller 幂等。
- 不在范围：跨机器分布式 Worker 和默认生产写入。

## 方案概览

```text
Scheduler(report-only) → Proposal Report → Approval
                                      ↓
Project Run Lease → Task Queue → Resource Claims → Worktree Worker
                                      ↓
Budget / Denylist / Pause / Kill / Connector Policy
```

## 详细设计

### Scheduling

保存 run ID、scan cursor、idempotency key 和项目 lease。report-only 阶段不创建 Task、不改代码。

### 资源协调

task lease 包含 owner、expiry、fencing token；resource claim 覆盖 repo path、branch/module、Simulator、DerivedData、工具实例。无冲突并发，冲突写串行。

### Pause/Kill

Pause 阻止新 Triage/Task/Round，允许安全 Gate 收尾。Kill 取消 Agent/命令，将操作标记 interrupted/unknown，保留 worktree/证据，reconcile 后才恢复。

### Connector

按项目授权，只读开始；评论/标签和有限状态更新单独批准。merge、delete、生产数据、credential、签名和发布默认 deny。

### 安全与审计

单任务/全局 Budget、path/action denylist、高风险人工 gate、所有 Policy decision 和外部副作用审计。

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| 重叠 Scheduler | 重复 Proposal/Task | project lease + idempotency | rebuild/report reconcile |
| 旧 Worker 双写 | 状态/代码冲突 | fencing token | 拒绝旧结果、丢弃 worktree |
| Connector 越权 | 外部损害 | per-project minimal scope | revoke token/pause project |

## 验证策略

report-only 指标、并发/冲突、Worker crash、Pause/Kill、Denylist、Connector 权限和多个真实低风险 Dogfood。

## 工单拆分

Phase 4 未满足进入条件，不创建工单。

## 实际实现

- 最终实现：未开始。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 融合 Scheduling、多任务与安全 | 最终 Roadmap | - |
