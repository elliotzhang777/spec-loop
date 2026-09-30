# 待完成任务看板

> 规格库轮次的完整盘点。列出 `spec/04-task/` 中全部未完成工单，包括待验证和受阻塞项；未获批准的工单可列入盘点，但不得因此启动实施。

## 当前轮次：2026-09-30 第二轮

| 工单 | 标题 | 状态 | 本轮下一动作 | 阻塞或待决 |
|---|---|---|---|---|
| [TASK-026](04-task/TASK-026-feishu-heavy-dogfood.md) | 飞书正式机器人 Dogfood 与最终 Heavy | 已批准 | 本机禁用配置模板与实测准备已完成，待真实配置后执行 | 真实飞书配置、外部副作用和 Heavy 决定 |
| [TASK-029](04-task/TASK-029-execution-view-hardening.md) | 执行可视化兼容重建、Dogfood 与加固验收 | 进行中 | TASK-028 已交付；`e5ddd81` 技术全量通过 | TASK-045 P 入口缺陷、独立角色链和 Heavy/视觉决定 |
| [TASK-033](04-task/TASK-033-pmvr-execution-observability.md) | P/M/V/R 执行事件与观察面 | 待验证 | 当前 HEAD 技术 V/R 与浏览器复核已通过，等待视觉决定 | 当前 revision 视觉决定 |
| [TASK-037](04-task/TASK-037-phase4-pmvr-heavy-dogfood.md) | Phase 4 P/M/V/R 自动闭环最终 Heavy | 已批准 | AC-3 report-only 门槛已量化；准备组合验收 | TASK-026/029 等依赖与最终 Heavy/阶段决定 |
| [TASK-044](04-task/TASK-044-report-only-v1-false-ready.md) | Report-only v1 Ready 误报缺陷 | 进行中 | `e5ddd81` 隔离组合候选受管 targeted Harness Gate 4/4 PASS | v2 M/V/R 独立角色链和最终 Evidence Gate 待办 |
| [TASK-045](04-task/TASK-045-proposal-unknown-domain-term.md) | Proposal 误判耗时精度术语 | 进行中 | 第二轮续执行复现已建缺陷；下一轮定向修复并全矩阵复测 | TASK-029 Contract P 入口受阻，正式 V/R 待办 |

第二轮起始盘点有 6 项未完成；TASK-028 已在 `6eef0ca` 完成委托视觉决定、定向 Gate 环境变化后的 3/3 重跑及 v1 Delivery；第二轮续执行再发现 TASK-045，当前仍有 6 项未完成。TASK-033 在 `6eef0ca` 的技术 V/R 与浏览器证据仍待当前最终候选视觉收口；TASK-029 隔离实现已在 `e5ddd81` 完成组合技术复测，但 Contract P 入口受 TASK-045 缺陷阻塞。以上证据绑定各自所列 HEAD，集成改变 HEAD 后须重新绑定正式 Gate、截图和 Evidence 才能进入集中裁决。

本轮逐项证据、当前候选和剩余条件见 [Phase 4 轮次待决清单](05-delivery/2026-09-30-Phase4-轮次待决清单.md)。TASK-029 的 8 AC/7 Gate 草案已通过 schema 和工具对照检查，尚未执行为正式 Heavy；TASK-044 的 v2 Contract 已按用户委托绑定 `PROP-13`，其 targeted Harness Gate 4/4 PASS，独立 V/R 未完成。

第一轮 [完整测试矩阵](05-delivery/2026-09-30-Phase4-完整轮次测试矩阵.md)在原 48 条 AC 中记 1 FAIL、26 BLOCKED、21 NOT_RUN，并将 Ready 误报建为 TASK-044。第二轮[完整矩阵](05-delivery/2026-09-30-Phase4-第二轮完整测试矩阵.md)增至 51 条 AC；组合候选 `49612eb` 的[336 个逐用例/场景技术复测](05-delivery/2026-09-30-Phase4-第二轮技术测试记录.md)全部通过。[续执行记录](05-delivery/2026-09-30-Phase4-第二轮续执行记录.md)记载 TASK-028 正式交付及 TASK-044 受管 Gate，最新形式状态为 16 PASS、29 BLOCKED、6 NOT_RUN；技术自测不能代替独立角色裁决。

2026-09-30 起按根目录 [执行与交付授权约定](../AGENT.md) 采用规格库轮次：本清单全部盘点，具备条件的 Task 连续推进，集成冻结后集中测试和裁决。内部 Wave 不再形成逐波次用户停点；Heavy/人工视觉/阶段验收及合并、推送、发布仍需在轮次清单明确决定。轮次不扩大 Task 范围，也不替代真实配置、依赖条件或验证证据。

## 使用规则

- 每轮从全部 `04-task/` 文件重建盘点；除“已完成”“已取消”外均保留在此表。
- 已批准且具备条件的工单才可进入实施；待验证工单同时列入[验证看板](verification-board.md)，外部阻塞项保留原因。
- 每轮裁决后更新状态与下一动作；关闭前把交付和验证结果写回正式工单及上游规格，再从本表移除。
- 测试失败先写入矩阵并按根因建缺陷工单；下一轮同时盘点原未完成工单和新缺陷工单，修复后重测完整适用矩阵。
