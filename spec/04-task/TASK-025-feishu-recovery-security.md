# TASK-025：飞书连接器恢复、安全与持续门禁

- 状态：已批准
- 优先级：P0
- 负责人：待定
- 创建日期：2026-08-04
- 最后更新：2026-08-04
- 所属设计：[DES-008](../03-design/DES-008-feishu-bot-connector.md)
- 所属特性：[FEAT-008](../02-feature/FEAT-008-feishu-progress-approval-connector.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 任务等级：Standard
- 依赖工单：TASK-022、TASK-024

## 目标

补齐连接器在重启、断线、限流、外部错误和攻击输入下的恢复、安全审计与持续 Gate，使远程确认失败时可解释、可回退且不越权。

## 工作范围

### 包含

- Inbox/Outbox/ConfirmationRequest reconcile；
- 断线重连、指数退避、dead-letter 和运维状态；
- Secret/Token/个人标识脱敏和卡片隐私策略；
- 回调重放、身份伪造、动作篡改、旧卡片、并发消费和状态文件篡改对抗测试；
- 自动发现飞书远程写入口的 fail-closed 持续 Gate；
- 禁用/吊销连接器和回退本地控制的运行手册。

### 不包含

- 真实应用最终 Dogfood 和 Phase 4 全量验收。

## 验收标准

- [ ] AC-1：任意步骤崩溃重启后可从本地事实恢复，不丢失有效确认，也不重复推进状态。
- [ ] AC-2：断线、429、5xx、权限撤销和目标不可用有明确状态、退避、告警和人工修复入口。
- [ ] AC-3：Secret canary、Token、Authorization header、原始个人标识和敏感 Evidence 不出现在输出与卡片中。
- [ ] AC-4：重放、伪造、篡改、并发和未知远程写入口对抗测试全部 fail closed。
- [ ] AC-5：标准质量 Profile 自动运行飞书 Connector Gate；新增未登记远程动作、卡片动作或 Controller Adapter 时门禁失败。
- [ ] AC-6：禁用或吊销连接器后，本地 Task、History、Evidence 和 Delivery 可继续正常使用。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1、AC-2 | 故障注入、重启和 reconcile 测试 | 可恢复、无重复副作用 |
| AC-3 | Secret/PII canary 全输出扫描 | 零明文泄漏 |
| AC-4 | 回调与状态对抗测试 | 未授权操作全部失败 |
| AC-5 | 自托管 Gate 突变测试 | 未登记入口被自动发现并拒绝 |
| AC-6 | Connector disable/revoke 回归 | Phase 1～3 本地闭环继续可用 |

## 验证范围

- `coverage: targeted`，覆盖飞书连接器安全、恢复和质量门禁。
- 不运行 Phase 4 其他 Feature 全量测试；不使用真实 Secret。

## 交付记录

- 完成日期：尚未实施（草稿阶段）
- 变更文件/交付物：实施完成后按实际结果记录
- 关键实现与决策：可重建状态、fail-closed 自动发现门禁和本地降级。
- 与原设计的差异：无
- 遗留风险：真实平台行为在 TASK-026 最终验证。
