# 待完成任务看板

> 临时执行队列。只列已经批准、尚未关闭的 `04-task/` 工单。

## 任务概览

| 工单 | 标题 | 优先级 | 状态 | 负责人 | 依赖/阻塞 | 更新时间 |
|---|---|---|---|---|---|---|
| [TASK-021](04-task/TASK-021-feishu-connector-foundation.md) | 飞书连接器配置与 SDK 基础 | P0 | 已批准 | Codex | Phase 4 Controller 接口草案 | 2026-08-04 |
| [TASK-022](04-task/TASK-022-feishu-progress-outbox.md) | 飞书进度投影与可靠 Outbox | P1 | 已批准 | Codex | TASK-021 | 2026-08-04 |
| [TASK-023](04-task/TASK-023-feishu-confirmation-contract.md) | 飞书确认请求与交互卡片契约 | P0 | 已批准 | Codex | TASK-021 | 2026-08-04 |
| [TASK-024](04-task/TASK-024-feishu-callback-identity.md) | 飞书长连接回调与身份授权 | P0 | 已批准 | Codex | TASK-023、Controller 结构化命令 | 2026-08-04 |
| [TASK-025](04-task/TASK-025-feishu-recovery-security.md) | 飞书连接器恢复、安全与持续门禁 | P0 | 已批准 | Codex | TASK-022、TASK-024 | 2026-08-04 |
| [TASK-026](04-task/TASK-026-feishu-heavy-dogfood.md) | 飞书正式机器人 Dogfood 与最终 Heavy | P0 | 已批准 | Codex | TASK-021～025、真实飞书配置 | 2026-08-04 |

Phase 1–3 已正式完成；Phase 4 仅 FEAT-008 飞书专项获实施授权，其他 Feature 尚未授权。

## 使用规则

- 工单状态达到“已批准”后加入。
- 开工后更新为“进行中”。
- 实现完成且需验证时移入验证看板。
- 关闭前必须把交付和验证结果写回正式工单及上游规格。
