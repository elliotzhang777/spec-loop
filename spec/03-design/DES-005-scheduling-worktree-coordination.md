# DES-005：Scheduling、Worktree 与资源协调

- 状态：已批准
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-09-04
- 所属特性：[FEAT-005](../02-feature/FEAT-005-scheduling-isolation.md)

## 设计目标

在 report-only 试运行后安全调度批准任务，保证代码、项目运行、工具资源和 Connector 权限不会冲突或越界。

## 现状与约束

- 现状：Phase 3 已完成多任务管理、串行单步 Harness、worktree 隔离和正式 Heavy 验收；当前没有 Scheduler。
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

### 调度

保存 run ID、scan cursor、idempotency key 和项目 lease。report-only 阶段不创建 Task、不改代码。

### 资源协调

task lease 包含 owner、expiry、fencing token；resource claim 覆盖 repo path、branch/module、Simulator、DerivedData、工具实例。无冲突并发，冲突写串行。

### Pause/Kill

Pause 阻止新 Triage/Task/Round，允许安全 Gate 收尾。Kill 取消 Agent/命令，将操作标记 interrupted/unknown，保留 worktree/证据，reconcile 后才恢复。

### 连接器

按项目授权，只读开始；评论/标签和有限状态更新单独批准。merge、delete、生产数据、credential、签名和发布默认 deny。飞书正式机器人的进度投影、远程身份、交互确认、Inbox/Outbox 与恢复契约由 [DES-008](DES-008-feishu-bot-connector.md) 定义。

### 安全与审计

单任务/全局 Budget、path/action denylist、高风险人工 gate、所有 Policy decision 和外部副作用审计。

### 常驻监督、恢复与产物保留

- `run-ready --execute` 必须绑定健康的独立 Supervisor；Supervisor 使用 PID 启动身份、单实例锁和自身心跳，每个 watchdog cycle 由独立超时子进程承担。
- Candidate baseline 漂移会保留旧 Candidate 事实、作废旧 V/R 绑定并自动重新排队，不静默复用 PASS。成功 invocation 若尚未摄入，明确进入等待摄入而不是继续计时。
- Project 级 `.spec-loop/shared-cache/` 复用 npm/Maven 下载；Evidence archive 只复制 Contract、Run、Plan、角色 manifest、Gate 与 hash Evidence，排除可重建候选快照。
- Dashboard Snapshot 上限 256 KiB；历史/当前/未启动状态分离。macOS 可审核 `launchd` 模板用于重启后恢复 Supervisor，但安装和卸载始终由用户显式执行。

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| 重叠 Scheduler | 重复 Proposal/Task | project lease + idempotency | rebuild/report reconcile |
| 旧 Worker 双写 | 状态/代码冲突 | fencing token | 拒绝旧结果、丢弃 worktree |
| Connector 越权 | 外部损害 | per-project minimal scope | revoke token/pause project |

## 验证策略

report-only 指标、并发/冲突、Worker crash、Pause/Kill、Denylist、Connector 权限和多个真实低风险 Dogfood。

## 工单拆分

| 工单 | 交付物 | 依赖 | 状态 |
|---|---|---|---|
| [TASK-034](../04-task/TASK-034-report-only-scheduler.md) | 幂等 report-only 扫描、建议与质量指标 | TASK-032 | 待验证 |
| [TASK-035](../04-task/TASK-035-scheduler-leases-controls.md) | Lease、fencing、resource claim、Pause/Kill 和受控 Ready 调度 | TASK-034 稳定 | 待验证 |
| [TASK-026](../04-task/TASK-026-feishu-heavy-dogfood.md) | 飞书真实连接器专项 Heavy | 真实配置、TASK-021～025 | 已批准 |
| [TASK-037](../04-task/TASK-037-phase4-pmvr-heavy-dogfood.md) | Phase 4 自动闭环最终 Heavy | 全部 Phase 4 子 Task | 已批准 |

## 实际实现

- 最终实现：report-only、Project/Task lease、fencing、resource claim、Pause/Kill/reconcile 与 denylist 已形成待验证候选。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 融合 Scheduling、多任务与安全 | 最终 Roadmap | - |
| 2026-08-04 | 引用飞书正式机器人专项设计与草稿工单 | 将通用 Connector Policy 与具体双向交互实现分层 | TASK-021～026 |
| 2026-09-04 | 拆分 report-only、受控调度与最终 Heavy | 对齐最新版 P/M/V/R，保持“先报告后执行”和唯一全量验收 | TASK-034、035、037 |
