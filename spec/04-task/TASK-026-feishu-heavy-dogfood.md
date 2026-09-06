# TASK-026：飞书正式机器人 Dogfood 与最终 Heavy

- 状态：已批准
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-08-04
- 最后更新：2026-09-04
- 所属设计：[DES-008](../03-design/DES-008-feishu-bot-connector.md)
- 所属特性：[FEAT-008](../02-feature/FEAT-008-feishu-progress-approval-connector.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 任务等级：Heavy
- 依赖工单：TASK-021～025、Phase 4 Controller 对应确认类型已实现
- Spec-Loop Task：`.spec-loop/tasks/task-026`
- Proposal：PROP-10
- 执行状态：已规划，等待真实飞书配置和单独启动授权
- 协议版本：P/M/V/R v2；现有 v1 `planned` 壳仅作历史索引，不得进入 Round
- 所属批次：P4-B4

## 目标

使用用户提供的真实飞书企业自建应用完成进度通知和远程确认 Dogfood，并以唯一一次飞书能力全量 Heavy 证明功能、安全、恢复和本地降级边界。

## P/M/V/R v2 对齐

- P：在真实配置写入前冻结租户范围、接收目标、身份映射、失败/回退用例、工具、断言和脱敏 Evidence；人批准 contract hash 后才能启动。
- M：只允许在隔离 worktree 修改实现与测试；真实 Secret 只进入本机环境，不写规格、日志或 Evidence。
- V：使用独立只读 invocation 执行发送/更新、越权拒绝、幂等、断线恢复和本地回退 Gate。
- R：仅在 V PASS 后复核当前 Contract、Plan、HEAD、卡片/Evidence hash 和隐私边界。
- Candidate 不授权 merge、push、deploy 或扩大飞书权限；Heavy 人工确认与外部副作用分别授权。

## 工作范围

### 包含

- 真实应用最小权限、机器人可用范围和接收目标检查；
- 一个真实 Project 的进度卡片持续更新；
- 一次未授权或失效卡片拒绝、一次有效确认、一次重复点击幂等；
- 一次断线/重启恢复和一次本地确认回退；
- TASK-021～025 全量组合 Gate、独立 Verifier 和用户 Heavy 人工验收；
- 正式 Delivery、规格回写和运行手册。

### 不包含

- 商店发布、多租户、生产部署、自动 merge/push/deploy 和 Phase 4 其他 Feature 的阶段验收。

## 验收标准

- [ ] AC-1：真实机器人向指定用户或群发送并更新项目总体进度卡片，内容与本地事实一致且无刷屏。
- [ ] AC-2：未授权用户或失效候选的操作被拒绝，Task 状态不变且审计原因清楚。
- [ ] AC-3：授权用户对当前候选的有效卡片决定只推进一次本地状态，并更新原卡片结果。
- [ ] AC-4：重复点击、回调重推、断线和进程重启后无重复状态迁移，Inbox/Outbox 可 reconcile。
- [ ] AC-5：飞书不可用时本地回退可完成同一确认，恢复后卡片状态与本地事实重新一致。
- [ ] AC-6：全量功能、安全、隐私和恢复 Gate PASS，输出不包含真实 Secret/Token；独立 Verifier PASS。
- [ ] AC-7：用户对当前真实卡片效果、提醒频率、确认流程和接受边界完成最终 Heavy 人工验收。
- [ ] AC-8：本工单使用 v2 Contract、稳定 HEAD、独立 V、独立 R 与 Evidence Gate；现有 v1 planned 壳未被错误执行或迁移。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1～AC-5 | 真实企业自建应用 Dogfood | 进度、拒绝、批准、幂等、恢复和回退全部通过 |
| AC-6 | 飞书能力 `coverage: full` Heavy Gate＋独立 Verifier | 全量 PASS，P0/P1 为 0 |
| AC-7 | 用户查看真实卡片并人工确认 | 当前候选 Heavy 通过或明确拒绝 |

## 验证范围

- `scope_kind: wave`，`wave_id: WPHASE4-FEISHU`，`coverage: full`。
- 这是飞书能力唯一一次全量 Heavy；TASK-021～025 不重复全量验证。
- 使用真实连接器时只记录脱敏 Evidence 和 artifact 哈希，不归档 Secret、Token 或原始个人标识。

## 人工效果验收

- 是否需要：是，声明 `REVIEW-1`。
- 验收范围：进度卡信息层级、密度、状态表达、提醒频率、确认卡片的风险与候选信息是否足以作出决定。
- 功能边界：人工 Review 不替代真实回调、身份、幂等和恢复 Gate。

## 交付记录

- 完成日期：已批准，尚未启动（等待真实飞书配置与单独启动授权）
- 变更文件/交付物：实施完成后按实际结果记录
- 关键实现与决策：实施完成后按实际结果记录
- 与原设计的差异：无
- 遗留风险：待 Heavy 后记录

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 对齐 P/M/V/R v2 | 工单尚未执行，可直接使用最新版架构；保留 v1 planned 壳只作历史索引 |
| 2026-09-04 | 修正交付记录状态 | 工单已批准但缺少真实配置和启动授权，不再错误标为草稿阶段 |
