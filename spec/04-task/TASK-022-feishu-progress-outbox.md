# TASK-022：飞书进度投影与可靠 Outbox

- 状态：草稿
- 优先级：P1
- 负责人：待定
- 创建日期：2026-08-04
- 最后更新：2026-08-04
- 所属设计：[DES-008](../03-design/DES-008-feishu-bot-connector.md)
- 所属特性：[FEAT-008](../02-feature/FEAT-008-feishu-progress-approval-connector.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 任务等级：Standard
- 依赖工单：TASK-021

## 目标

把 Project、Task、Harness、Gate 和 Delivery 事实投影成简洁的飞书总体进度卡片，并通过持久 Outbox 聚合、发送、更新和重试。

## 工作范围

### 包含

- 可从本地事实重建的 ProgressSnapshot；
- 项目/波次总体进度卡片和关键异常通知卡片；
- Outbox 状态机、幂等键、消息 ID、聚合窗口和优先级；
- 限流、5xx、网络失败、卡片丢失和目标不可用处理；
- 连接器状态中展示堆积、最近发送和 dead-letter。

### 不包含

- 用户点击卡片后的确认处理。

## 验收标准

- [ ] AC-1：总体卡片准确显示 Task 总量、各状态数量、当前 Task/Round/Harness 步骤、最近 Gate/Verifier 和下次用户介入点。
- [ ] AC-2：高频 Attempt 在聚合窗口内合并，同一项目优先更新一张卡片，不产生逐事件刷屏。
- [ ] AC-3：重试、重启和重复事件不会重复发送关键消息，旧快照可被更新快照安全替代。
- [ ] AC-4：429、5xx、网络错误和永久权限错误被正确分类，普通通知失败不修改或阻断 Task 状态。
- [ ] AC-5：卡片只包含允许公开的摘要，不泄漏源码、完整日志、Secret、Token 或敏感 Evidence。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1 | Snapshot fixture 单元测试 | 投影与本地事实一致 |
| AC-2、AC-3 | 高频事件、重启和重复事件集成测试 | 单卡更新且无重复关键消息 |
| AC-4 | Fake API 注入 429/5xx/403/网络故障 | 正确退避或 dead-letter |
| AC-5 | 卡片快照与敏感 canary 扫描 | 只包含允许字段 |

## 验证范围

- `coverage: targeted`，只验证进度投影、卡片渲染和 Outbox。
- 不连接真实飞书，不运行其他 Phase 4 Task Gate。

## 交付记录

- 完成日期：尚未实施（草稿阶段）
- 变更文件/交付物：实施完成后按实际结果记录
- 关键实现与决策：进度卡 Projection-only、单卡更新和持久 Outbox。
- 与原设计的差异：无
- 遗留风险：真实平台限流行为在 TASK-026 验证。
