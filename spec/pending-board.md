# 待完成任务看板

> 规格库轮次的完整盘点。列出 `spec/04-task/` 中全部未完成工单，包括待验证和受阻塞项；未获批准的工单可列入盘点，但不得因此启动实施。

## 当前轮次：2026-10-02 Phase 4 交付后缺陷收口

| 工单 | 标题 | 状态 | 本轮下一动作 | 阻塞或待决 |
|---|---|---|---|---|---|

第九轮结束时无未完成工单；2026-10-02 用户接受 TASK-029/037 的当前候选后 `R=0`，见[最终人工验收记录](05-delivery/2026-10-02-Phase4-最终人工验收记录.md)。交付后新发现的 TASK-063 已按定向测试和独立 V/R 关闭，当前未完成 `R=0`；下方旧轮次段落保留为历史过程。

第二轮起始盘点有 6 项未完成；TASK-028 已在 `6eef0ca` 完成委托视觉决定、定向 Gate 环境变化后的 3/3 重跑及 v1 Delivery；第二轮续执行再发现 TASK-045，TASK-033 视觉收口后新建 TASK-046。第三轮组合候选 `7f5cacd` 完成了 TASK-029、044、045、046 的技术 Gate；第四轮 TASK-044 在 `78bfd70`、TASK-046 在 `9e95565` 分别通过独立 V/R 并形成 Candidate，用户随后取消 TASK-026，第四轮当前 HEAD 的质量 Gate 失败建立 TASK-047；当前剩余 4 项。其他工单正式 v2 角色链仍以受管记录为准。

飞书功能已由用户撤下：TASK-026 与 FEAT-008/DES-008 均已取消，受管历史壳为 cancelled；Phase 4 改用本地人工确认，不再等待真实飞书配置。

第三轮逐项证据见[第三轮候选记录](05-delivery/2026-09-30-Phase4-第三轮最终候选技术与验收记录.md)。TASK-044 第四轮 `78bfd70` 的 targeted Gate 4/4、独立 V/R 均 PASS，正式工单已关闭；TASK-029 在旧候选 `7f5cacd` 的 Heavy 7/7 PASS，现有新组合 HEAD 需要重新验证。

第四轮[完整矩阵](05-delivery/2026-09-30-Phase4-第四轮完整测试矩阵.md)与[逐用例台账](05-delivery/2026-09-30-Phase4-第四轮最终候选逐用例结果.json)记录 `36c631a`：七组 Heavy 6/7，Node 320/321、Playwright 2/2；报告型调度 `missing_data=1`。两个技术 FAIL 分别转 TASK-047 与现有 TASK-045。第五轮 TASK-029 集成修复 `4f7fb6e`、TASK-047 独立 M `70688bb`，当前均未沿用旧候选 PASS。

第五轮 `4f7fb6e` 再次为七组 Heavy 6/7、Node 320/321、Playwright 2/2，失败用例换为后台执行视图启动超时。该失败建 TASK-048；Controller 把它与第四轮的不同根因误合并为重复指纹，另建 TASK-049。受管 Conflict 及按用户连续推进委托所作的 `change_approach` 均留有权威记录。TASK-045 修订通道缺口另建 TASK-050 并获 P 批准；新增三单后当时剩余 `R=7`。随后 TASK-045、047～050 的独立 V/R 已形成 Candidate，TASK-051 随 TASK-045 修复关闭；TASK-049 首次 R 的新缺陷建 TASK-052，第六轮 full 又发现 TASK-053。第七轮两项均关闭，当前结果见下方门槛和[完整矩阵](05-delivery/2026-10-01-Phase4-第七轮完整测试矩阵.md)。

第一轮 [完整测试矩阵](05-delivery/2026-09-30-Phase4-完整轮次测试矩阵.md)在原 48 条 AC 中记 1 FAIL、26 BLOCKED、21 NOT_RUN，并将 Ready 误报建为 TASK-044。第二轮[完整矩阵](05-delivery/2026-09-30-Phase4-第二轮完整测试矩阵.md)增至 51 条 AC；组合候选 `49612eb` 的[336 个逐用例/场景技术复测](05-delivery/2026-09-30-Phase4-第二轮技术测试记录.md)全部通过。[续执行记录](05-delivery/2026-09-30-Phase4-第二轮续执行记录.md)记载 TASK-028 正式交付及 TASK-044 受管 Gate，第三轮 57 项形式状态为 23 PASS、1 FAIL、33 BLOCKED、0 NOT_RUN；技术自测不能代替独立角色裁决。

2026-09-30 起按根目录 [执行与交付授权约定](../AGENT.md) 采用规格库轮次：本清单全部盘点，具备条件的 Task 连续推进，集成冻结后集中测试和裁决。内部 Wave 不再形成逐波次用户停点；Heavy/人工视觉/阶段验收及合并、推送、发布仍需在轮次清单明确决定。轮次不扩大 Task 范围，也不替代真实配置、依赖条件或验证证据。

本次连续推进的固定基线是用户补充停止规则时的 `N=6`（TASK-026、029、037、044、045、046）；新缺陷 TASK-047～053 均计入剩余数。TASK-026 已取消，TASK-044～053 均已完成；当前仅 TASK-029、037 未完成，`R=2`。第七轮 78 条 AC 与 343 项逐用例技术台账已经裁决，见[完整矩阵](05-delivery/2026-10-01-Phase4-第七轮完整测试矩阵.md)。严格停止条件 `R < 3` 已满足，停止自动进入下一轮并将两项未决提交用户判断；BLOCKED 保持 BLOCKED。

2026-10-01 用户改定后续停止条件为 `R=0` 且适用验收全部通过，并要求继续解决两项未完成工单。上一段的 `R<3` 是第七轮历史裁决，不再是当前收口依据；当前 `R=2`，继续推进。

第八轮 TASK-037 P onboarding 又发现 [TASK-054](04-task/TASK-054-approved-existing-task-adoption.md)：已批准且 AC 完全一致的目标工单不能由已批准 P Proposal 导入控制面。缺陷计入剩余数后当前 `R=3`，P Proposal `PROP-23`/`APR-25` 已记录；当前 TASK-029 受管验证结束后修复并进入下一轮完整矩阵。

第八轮 TASK-029 当前候选正式 V 的 7 项 Gate 为 6 PASS、1 FAIL；全量 Node 326 项为 325 PASS、1 FAIL。失败是恢复用例在主动阻塞 watchdog 时触发持续失败熔断，随后错误断言可自动恢复，见 [TASK-055](04-task/TASK-055-supervisor-timeout-recovery-test-circuit.md)。保留失败 Evidence 和受管 Conflict，不把本轮记为通过；新缺陷计入后 `R=4`。下轮修复并重跑完整适用矩阵。

TASK-055 已由 `PROP-24`/`APR-26` 导入受管 P；隔离修复提交 `897480f` 的定向 Scheduler 套件 8/8 PASS，仍待 TASK-029 新候选完整 Heavy V/R。TASK-054 隔离修复提交 `cfaa01e` 的 Project 测试 10/10 PASS，仍待受管 Task 导入及正式 V/R。两项技术自测均不改变 `R=4`。

TASK-054 已由 `PROP-23`/`APR-25` 导入受管 P；使用其已验证的修复 CLI，原已批准且未绑定的 TASK-037 已由 `PROP-22`/`APR-24` 成功导入，规格状态保留“已批准”。TASK-037 尚未开始 M/V/R，TASK-054 修复仍需进入正式候选和 Gate，`R=4` 不变。

第九轮 TASK-029 当前 HEAD `3be7123` 的完整 Heavy Gate 7/7、Node 326/326、独立 V/R PASS，受管 Stage 为 Candidate。重跑暴露历史 Gate 原始证据固定路径覆写，按根因新建 [TASK-056](04-task/TASK-056-gate-evidence-immutable-runs.md)；旧失败受管判定仍在，旧原始日志不可恢复。当前未完成总数 `R=5`，依照用户最新规则继续至 `R=0` 且适用验收全部通过。

TASK-055 当前候选定向 Gate 2/2、Scheduler 8/8、独立 V/R PASS，TASK-029 完整 Heavy 已覆盖其修复，工单关闭。TASK-037 正式 V 在全量前发现 Dogfood 人工介入误报和 Spring HEAD 判定漏检；浏览器预检同时发现默认二进制缺失，分别建立 TASK-058～060。真实 report-only 又发现初版 TASK-037 v2 依赖数据错误，建立并完成 [TASK-057](04-task/TASK-057-phase4-invalid-v2-dependencies.md)，Contract v2 修订后两次扫描 `missing_data=0`。当前未完成总数 `R=7`：TASK-029、037、054、056、058～060。

TASK-037 当前 HEAD `2ebee82` 的独立 V 源码/证据审查已 PASS，但 Controller 在执行全量前发现已批准的 Playwright Gate 缺少 v1 Task 壳声明；建 [TASK-061](04-task/TASK-061-phase4-playwright-declaration.md)。未开始 Round 的壳与状态 hash 已审计修正，当前正在运行八组受控 Gate。修正后的未完成总数 `R=8`，以本轮完整验证和 R 裁决为准。

TASK-037 修正声明后受控 V 的前七组 Gate 均 PASS，Node 334/334；第八组 Playwright 在启动前拒绝工作树外的依赖软链接，建 [TASK-062](04-task/TASK-062-phase4-playwright-local-runtime.md)。本地锁定依赖安装与浏览器预检 2/2 已通过，候选 HEAD 不变；受控 V 需重跑 8/8。当前未完成总数 `R=9`，前七组的 PASS 仅作为保留历史证据，不能当作新运行的完成结论。

第九轮最终技术裁决：TASK-037 重新受控运行 8/8 Gate、Node 334/334、Playwright 2/2，补齐实时双 Project report-only 与当前 revision 视觉 Review 后独立 V/R PASS，成为 Candidate。TASK-054/056 的定向 Gate、独立 V/R 及 TASK-037 集成矩阵均 PASS；TASK-058 自身 Heavy 4/4、独立 V/R 与最终 Dogfood PASS；TASK-059～062 均按其 AC 关闭。全规格库排除模板后仅 TASK-029、037 未完成，当前 `R=2`；两单唯一未满足的范围是用户绑定当前 revision 的最终 Heavy/Phase 4 人工决定。用户最新停止条件为 `R=0` 且全部适用 AC PASS，因此本轮尚不能声称完成或自动 Delivery。

## 使用规则

- 每轮从全部 `04-task/` 文件重建盘点；除“已完成”“已取消”外均保留在此表。
- 已批准且具备条件的工单才可进入实施；待验证工单同时列入[验证看板](verification-board.md)，外部阻塞项保留原因。
- 每轮裁决后更新状态与下一动作；关闭前把交付和验证结果写回正式工单及上游规格，再从本表移除。
- 测试失败先写入矩阵并按根因建缺陷工单；下一轮同时盘点原未完成工单和新缺陷工单，修复后重测完整适用矩阵。

第三轮组合候选 `7f5cacd` 的[逐用例技术台账](05-delivery/2026-09-30-Phase4-第三轮最终候选逐用例结果.json)为 337 PASS、1 FAIL；唯一 FAIL 是 TASK-045 已批准 Contract 的未受管历史依赖使报告 `missing_data=1`。该台账保留历史结论，不能直接充当新 HEAD `78bfd70` 的完整回归结果。
