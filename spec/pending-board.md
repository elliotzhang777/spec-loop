# 待完成任务看板

> 规格库轮次的完整盘点。列出 `spec/04-task/` 中全部未完成工单，包括待验证和受阻塞项；未获批准的工单可列入盘点，但不得因此启动实施。

## 当前轮次：2026-09-30

| 工单 | 标题 | 状态 | 本轮下一动作 | 阻塞或待决 |
|---|---|---|---|---|
| [TASK-026](04-task/TASK-026-feishu-heavy-dogfood.md) | 飞书正式机器人 Dogfood 与最终 Heavy | 已批准 | 本机禁用配置模板与实测准备已完成，待真实配置后执行 | 真实飞书配置、外部副作用和 Heavy 决定 |
| [TASK-028](04-task/TASK-028-execution-view.md) | 可重建投影与本地执行 Web UI | 待验证 | 当前 HEAD 技术 V/R 与 Gate 已通过，等待视觉决定和 v1 Delivery | 当前 revision 视觉决定与 v1 Delivery |
| [TASK-029](04-task/TASK-029-execution-view-hardening.md) | 执行可视化兼容重建、Dogfood 与加固验收 | 进行中 | Contract/Gate 草案已校验；前置交付后绑定受管候选并执行 V/R | TASK-028 前置与精确 Contract hash、人工 Heavy/视觉决定；技术全量自测已通过 |
| [TASK-033](04-task/TASK-033-pmvr-execution-observability.md) | P/M/V/R 执行事件与观察面 | 待验证 | 当前 HEAD 技术 V/R 与浏览器复核已通过，等待视觉决定 | 当前 revision 视觉决定 |
| [TASK-037](04-task/TASK-037-phase4-pmvr-heavy-dogfood.md) | Phase 4 P/M/V/R 自动闭环最终 Heavy | 已批准 | 准备组合验收清单 | TASK-026/029 等依赖与最终 Heavy/阶段决定 |

本轮盘点与 `spec/04-task/` 状态一致：未完成 5 项。Phase 1–3 已正式完成；TASK-009、010、012 的历史“待验证”已依据 TASK-013 最终 Heavy Evidence 纠正为“已完成”。TASK-028 在 `6eef0ca` 的正式定向 Gate 3/3、桌面/390px 截图及平板宽度回归通过；TASK-033 同 HEAD 桌面/390px Chrome 截图通过，四张截图与 Gate/Web Manifest 哈希重新核对。TASK-029 在隔离候选 `e4d8670` 的 319/319 全量自测、200×200 性能、三项目 Dogfood 与四条浏览器路径通过；当前隔离 HEAD `2a9e57a` 的定向测试 29/29 与编译通过，完整证据仍须重绑；正式受管 Heavy 与独立 V/R 待前置。以上证据绑定各自所列 HEAD，若集成改变 HEAD，必须重新绑定后才能进入集中裁决。

本轮逐项证据、当前候选和剩余条件见 [Phase 4 轮次待决清单](05-delivery/2026-09-30-Phase4-轮次待决清单.md)。TASK-029 的 8 AC/7 Gate 草案已通过 schema 和工具对照检查，尚未批准或执行为正式 Heavy。

本轮 [完整测试矩阵](05-delivery/2026-09-30-Phase4-完整轮次测试矩阵.md)列出 48 条目标 AC 及 Gate/回归来源；现为 17 条 BLOCKED、31 条 NOT_RUN、0 条本轮 PASS/FAIL。尚未冻结跨 Task 候选，不能启动整轮最终裁决。集中测试中确认的缺陷须建立新 Task 并在下轮加入本看板；目前没有已确认的新缺陷工单。

2026-09-30 起按根目录 [执行与交付授权约定](../AGENT.md) 采用规格库轮次：本清单全部盘点，具备条件的 Task 连续推进，集成冻结后集中测试和裁决。内部 Wave 不再形成逐波次用户停点；Heavy/人工视觉/阶段验收及合并、推送、发布仍需在轮次清单明确决定。轮次不扩大 Task 范围，也不替代真实配置、依赖条件或验证证据。

## 使用规则

- 每轮从全部 `04-task/` 文件重建盘点；除“已完成”“已取消”外均保留在此表。
- 已批准且具备条件的工单才可进入实施；待验证工单同时列入[验证看板](verification-board.md)，外部阻塞项保留原因。
- 每轮裁决后更新状态与下一动作；关闭前把交付和验证结果写回正式工单及上游规格，再从本表移除。
- 测试失败先写入矩阵并按根因建缺陷工单；下一轮同时盘点原未完成工单和新缺陷工单，修复后重测完整适用矩阵。
