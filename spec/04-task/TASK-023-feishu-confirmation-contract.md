# TASK-023：飞书确认请求与交互卡片契约

- 状态：进行中
- 优先级：P0
- 负责人：待定
- 创建日期：2026-08-04
- 最后更新：2026-08-04
- 所属设计：[DES-008](../03-design/DES-008-feishu-bot-connector.md)
- 所属特性：[FEAT-008](../02-feature/FEAT-008-feishu-progress-approval-connector.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 任务等级：Standard
- 依赖工单：TASK-021

## 目标

建立与当前候选严格绑定、可过期、单次消费的 ConfirmationRequest，并为允许的五类人工卡点生成结构化飞书卡片。

## 工作范围

### 包含

- ConfirmationRequest Schema、状态历史和内容哈希；
- Proposal、`needs_user`、视觉 Review、正式验证授权和 Heavy 验收卡片；
- 请求创建、查询、失效、过期、消费和重新生成接口；
- 卡片只回传不透明请求 ID 与固定动作 ID；
- 候选或截图变化时自动失效旧请求。

### 不包含

- 飞书回调身份认证和 Controller 实际状态迁移；
- merge、push、deploy、生产操作和自由文本授权。

## 验收标准

- [ ] AC-1：每个请求绑定 Task、类型、Round、revision、content hash、risk、有效期、允许用户和允许动作。
- [ ] AC-2：五类卡片完整展示用户作出决定所需的范围、风险、Evidence 摘要和失效条件。
- [ ] AC-3：候选 revision、Acceptance、截图或 Gate Plan 变化后旧请求立即失效。
- [ ] AC-4：卡片 payload 不包含可篡改的授权范围，也不提供 MVP 禁止动作。
- [ ] AC-5：请求状态可从历史重建，手工篡改当前投影会被检查发现。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1、AC-3 | 候选/时间/内容变化单元与对抗测试 | 旧请求 fail closed |
| AC-2、AC-4 | 卡片 Schema 快照和动作 allowlist 测试 | 信息完整且无越权动作 |
| AC-5 | 删除投影、篡改投影和历史重建测试 | 可恢复并识别篡改 |

## 验证范围

- `coverage: targeted`，只验证 ConfirmationRequest、卡片模板和失效逻辑。
- 不消费真实飞书回调，不运行完整 Phase 4 Gate。

## 交付记录

- 完成日期：尚未实施（草稿阶段）
- 变更文件/交付物：实施完成后按实际结果记录
- 关键实现与决策：固定动作、权威范围留在本地、候选变化即失效。
- 与原设计的差异：无
- 遗留风险：远程身份与并发消费在 TASK-024 处理。
