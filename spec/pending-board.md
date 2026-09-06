# 待完成任务看板

> 临时执行队列。只列已经批准、尚未关闭的 `04-task/` 工单。

## 任务概览

| 工单 | 标题 | 优先级 | 状态 | 负责人 | 依赖/阻塞 | 更新时间 |
|---|---|---|---|---|---|---|
| [TASK-026](04-task/TASK-026-feishu-heavy-dogfood.md) | 飞书正式机器人 Dogfood 与最终 Heavy | P0 | 已批准 | Codex | TASK-021～025 已完成；等待真实飞书配置与启动授权 | 2026-08-06 |
| [TASK-027](04-task/TASK-027-execution-events.md) | 执行事件协议与全入口埋点 | P1 | 进行中 | Codex | P4-B1 已启动；定向检查通过，待稳定候选和正式验证 | 2026-09-04 |
| [TASK-028](04-task/TASK-028-execution-view.md) | 可重建投影与本地执行 Web UI | P1 | 进行中 | Codex | P4-B1 已启动；构建/14 项测试通过，待真实浏览器反馈 | 2026-09-04 |
| [TASK-029](04-task/TASK-029-execution-view-hardening.md) | 执行可视化 v2 Heavy 加固验收 | P1 | 进行中 | Codex | 后台 view 生命周期已实现；等待 TASK-027/028、真实浏览器与正式 Heavy 授权 | 2026-09-04 |
| [TASK-033](04-task/TASK-033-pmvr-execution-observability.md) | P/M/V/R 执行事件与观察面接入 | P1 | 进行中 | Codex | 代码/定向测试已完成；等待 TASK-027/028 收口和真实浏览器反馈 | 2026-09-04 |
| [TASK-037](04-task/TASK-037-phase4-pmvr-heavy-dogfood.md) | Phase 4 P/M/V/R 自动闭环最终 Heavy | P0 | 已批准 | Codex | 等待 TASK-026、029、031～036 与正式 Heavy 授权 | 2026-09-04 |

Phase 1–3 已正式完成；TASK-009、010、012 的历史“待验证”已依据 TASK-013 最终 Heavy Evidence 纠正为“已完成”。Phase 4 已按 P4-B1～B4 编排：B1/TASK-033 仍待真实浏览器反馈；TASK-030～032、034～036 已形成实现候选并移入验证看板；B4 的 TASK-026/029/037 仍受真实配置、稳定候选和正式验证/Heavy 授权阻塞。任何正式 V/R、完整 Gate、Heavy/阶段验收和外部副作用仍需当前稳定候选上的单独授权。

## 使用规则

- 工单状态达到“已批准”后加入。
- 开工后更新为“进行中”。
- 实现完成且需验证时移入验证看板。
- 关闭前必须把交付和验证结果写回正式工单及上游规格。
