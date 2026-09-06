# 验证看板

> 临时验证队列。验证方案、Evidence 和结论必须写回对应工单。

## 待验证概览

| 工单 | 验证范围 | 验证方式 | 验证人 | 状态 | 环境/入口 | 更新时间 |
|---|---|---|---|---|---|---|
| [TASK-030](04-task/TASK-030-pmvr-acceptance-loop.md) | v2 Contract、HEAD/计划/Evidence 绑定、V/R 路由、预算、Conflict/Inbox、调度和 v1 兼容 | 独立 V 执行定向 Gate；独立 R 复核 Evidence，必要时再申请 Heavy | 待独立 V/R；未获得正式验证授权 | 待验证 | `src/acceptance-loop.ts`、`test/acceptance-loop.test.mjs` | 2026-09-04 |
| [TASK-031](04-task/TASK-031-v2-contract-onboarding.md) | 默认 v2、P 契约同步、Proposal hash、v1/v2 双轨、doctor/status、不可变 v5 模板 | 独立 V 执行协议切换/篡改/模板摘要定向 Gate；独立 R 复核 | 待独立 V/R；未获得正式验证授权 | 待验证 | `src/project.ts`、`src/target-spec.ts`、`test/project.test.mjs`、`test/target-spec.test.mjs` | 2026-09-04 |
| [TASK-032](04-task/TASK-032-pmvr-role-orchestration.md) | M/V/R invocation、候选权限隔离、Provider 生命周期、reconcile、强制结果绑定和 Candidate 新鲜度 | 独立 V 执行伪 Provider/篡改/超时/取消/崩溃定向 Gate；独立 R 复核 | 2026-09-06 防卡死专项 V/R 已完成；全工单仍待独立验收 | 待验证 | `src/role-orchestrator.ts`、`src/acceptance-loop.ts`、`test/acceptance-loop.test.mjs` | 2026-09-06 |
| [TASK-034](04-task/TASK-034-report-only-scheduler.md) | canonical report、cursor、去重、Ready/blocked、质量指标、Pause 和并发扫描 | 独立 V 执行多 Project/过期/损坏/并发/Secret 定向 Gate；独立 R 复核 | 待独立 V/R；未获得正式验证授权 | 待验证 | `src/report-scheduler.ts`、`test/report-scheduler.test.mjs` | 2026-09-04 |
| [TASK-035](04-task/TASK-035-scheduler-leases-controls.md) | Project/Task lease、fencing、resource claim、Pause/Kill/reconcile 和 denylist | 独立 V 执行并发、故障注入、陈旧 Worker 和 PID/回调对抗；独立 R 复核 | 2026-09-06 Supervisor/取消/锁/波次熔断专项 V/R 已完成；全工单仍待独立验收 | 待验证 | `src/scheduler-control.ts`、`test/scheduler-control.test.mjs` | 2026-09-06 |
| [TASK-036](04-task/TASK-036-gate-planner-spring-toolchain.md) | v2 Gate Planner、阶段/范围、影响升级、Spring Maven/Gradle 检测和原生 Evidence | 独立 V 执行真实 Maven/Gradle Fixture、零测试/篡改/漂移；独立 R 复核 | 待独立 V/R；未获得正式验证授权 | 待验证 | `src/toolchain.ts`、`test/toolchain.test.mjs` | 2026-09-04 |
| [TASK-038](04-task/TASK-038-unified-product-output.md) | `products/` 目录契约、Git 忽略、manifest 与 SHA-256、首个 APK 迁移 | 独立 V 复核目录、清单、忽略规则与哈希；必要时扩展 CLI 发布设计 | 待独立 V/R；未获得正式验证授权 | 待验证 | `products/README.md`、`products/concert-ticket-assistant/0.2.0/` | 2026-09-04 |

Phase 1–3 的验证已写入已完成工单和阶段交付归档。

## 使用规则

- 只有实现完成且具备验证条件的工单才能进入。
- 验证失败时写回工单，恢复为进行中并移回待完成看板。
- 验证通过时同步 Task、Design、Feature、Product，然后删除看板条目。
