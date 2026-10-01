# PROD-001：本地规格驱动任务闭环

- 状态：进行中
- 负责人：zhangbo
- 创建日期：2026-07-12
- 最后更新：2026-08-03
- Roadmap：[roadmap.md](../roadmap.md)
- 总体架构：[architecture.md](../architecture.md)

## 背景与问题

真实工程任务通常经过需求理解、计划、编码、测试、失败修复、验收和交付。使用 AI Agent 时，人仍需要在每轮复制错误、补充 Prompt、提醒范围和决定是否完成，且聊天记录无法充当可靠状态与证据。

## 产品目标

- 目标：以 Task Spec 为输入，管理 `SPEC → PLAN → WORK → VERIFY → ITERATE → ACCEPTANCE → DELIVERY` 的完整本地闭环。
- 成功指标：循环内人工追加“继续修复/运行测试”Prompt 为 0；每条 AC 拥有当前有效 Evidence；失败可停止和恢复。
- 基线与目标值：Phase 1–2 已实现 A0/T0/D0；目标逐步达到 A3 多任务闭环，不默认追求 A4 无人值守。

## 范围

### 包含

- Light、Standard、Heavy 任务治理；
- 生命周期、Round、Attempt、Budget、Guard、Evidence 和 Delivery；
- 初始化并校验目标工程自身的分层规格库，确保业务规格随代码仓库长期维护；
- 后续可配置 Agent Provider；
- 后续 Git/worktree、多任务和工程 Toolchain；
- 独立验证、人工门禁、审计和恢复。
- UI 效果图的显式人工验收，以及 Web 系统真实浏览器功能验证；
- 从每个 Project 的 `.spec-loop/` 重建当前执行、历史步骤和耗时的只读可视化观察面。

### 不包含

- 默认自动批准、merge、deploy、App Store 发布；
- 在 Ledger、日志或 Summary 中保存 Secret；
- 用 Agent 自述替代测试和验收证据；
- 把 spec-loop 作为目标业务代码事实源。

## 用户与关键旅程

| 用户角色 | 触发场景 | 期望结果 |
|---|---|---|
| 个人开发者 | 同时推进多个清晰工程任务 | 一次下发规格，系统持续闭环并只在关键决策时找人 |
| Agent 使用者 | 使用 Codex、Claude Code 或 Qoder | Provider 可替换，任务契约和验收不变化 |
| Reviewer | 高风险或 Heavy 任务待验收 | 能看到 Round、失败历史、当前 Evidence 和风险 |

## 产品约束

- 业务约束：目标工程代码和 Git 历史是代码事实源；目标工程 `spec/` 是该系统业务规格事实源，Spec-Loop 控制目录只保存任务契约、运行状态和证据。
- 安全约束：最小权限、无 Secret 持久化、高风险动作人工门禁。
- 技术约束：本地优先；Phase 1–2 不依赖后台服务或数据库。
- 兼容约束：未来能力不得削弱已实现的状态、Evidence、Guard 和 Heavy 要求。
- 执行与验收授权：已批准 Task 按各自规格、权限、Gate 计划和预算连续完成实现、自测与 V/R；纳入规格库轮次不扩大授权。候选变化只作废旧验证证据及最终验收决定，不撤销范围内执行授权。普通人工确认集中到轮次裁决，交付、视觉/Heavy/阶段验收和外部动作仍须明确决定。
- 规格库轮次节奏：每轮盘点全部未完成 Task 及全部批准用例，按依赖推进具备条件的工作；集成冻结候选后按完整矩阵集中测试、独立 V/R 和人工裁决。失败用例归因后形成缺陷 Task，下一轮连同原未完成 Task 一起修复并重测完整适用矩阵；外部阻塞及未决事项保留原因。Task 是最小验收单位，波次仅作内部调度和证据分组，不再作为向用户逐次请求推进的单位。已有在途 Task 保留原协议与预算。
- 连续轮次的停止门槛：以启动时全规格库未完成 Task 数为固定基线；新缺陷 Task 加入剩余数。完成当前轮次验证后，剩余数严格小于基线的 10%，或严格小于 3，才向用户提交全部剩余问题供其决定是否做完。阻塞项仍算未完成，门槛不改变 Gate、V/R 或人工验收要求。

## 特性拆分

| Feature | 价值 | 优先级 | 状态 |
|---|---|---|---|
| [FEAT-001 文件驱动生命周期](../02-feature/FEAT-001-file-task-lifecycle.md) | 建立任务契约、状态、验收和 Delivery | P0 | 已完成 |
| [FEAT-002 运行账本与 Guard](../02-feature/FEAT-002-runtime-ledger-guard.md) | 多轮失败可记录、限制和恢复 | P0 | 已完成 |
| [FEAT-003 Project Loop 与 Agent 执行](../02-feature/FEAT-003-project-loop-agent-execution.md) | 管理项目多任务并让 Codex 受控单步执行 | P1 | 已完成 |
| [FEAT-004 受控自动闭环](../02-feature/FEAT-004-controlled-automation.md) | 批准后替代循环内重复 Prompt | P1 | 草稿 |
| [FEAT-005 Scheduling 与隔离](../02-feature/FEAT-005-scheduling-isolation.md) | 报告型调度、并发隔离和安全控制 | P1 | 草稿 |
| [FEAT-006 工程 Toolchain](../02-feature/FEAT-006-engineering-toolchains.md) | 自动构建、测试并生成平台证据 | P1 | 进行中 |
| [FEAT-007 Portfolio 与持续优化](../02-feature/FEAT-007-portfolio-capability-optimization.md) | 多项目组合、能力资产和优化治理 | P2 | 草稿 |
| [FEAT-008 飞书进度通知与确认连接器](../02-feature/FEAT-008-feishu-progress-approval-connector.md) | 历史设计与实现保留，当前不启用 | P1 | 已取消 |
| [FEAT-009 可重建执行可视化](../02-feature/FEAT-009-execution-visualization.md) | 查看当前任务/步骤、历史耗时和 Evidence 路径 | P1 | 进行中 |

## 实际结果

- 当前结果：Phase 1–3 已交付；Phase 3 的 Project Loop、安全加固、故障恢复、Web Gate、人工效果门禁和分工程规格模板已经完成正式 Heavy 验收。
- 指标结果：最终候选的 67 项自动化、对抗和恢复测试全部通过，WPHASE3 全量 Harness Gate、独立 Verifier 和用户 Heavy 人工确认均为 PASS。
- 遗留事项：自动多 Round、受控并发、Xcode/小程序平台预设和 Portfolio 仍待后续工单；Spring T2、Gate Planner 与 report-only Scheduling 已完成定向验收，Phase 4 全量 Heavy 尚未执行。
- 2026-09-29 Phase 4 增量：TASK-034 report-only Scheduler 在候选 `cbc1a5d` 上通过独立 V/R；其余 Scheduling 自动执行、阶段 Heavy 与产品交付仍按对应工单验收。
- 同一候选的 TASK-035 波次调度与防卡死能力已通过独立 V/R 和用户人工视觉 Review；Phase 4 最终 Heavy、真实业务角色与产品交付仍待各自门槛。
- 2026-09-29 TASK-030 P/M/V/R v2 旁路内核在候选 `eb05e92` 通过独立 V/R，覆盖 Contract、HEAD/计划/Evidence、路由预算、Conflict/Inbox、人工动作及 v1 兼容；新任务默认 v2 接入由 TASK-031 继续验收。
- 2026-09-29 TASK-030/031 在更新后的候选 `7177a72` 重新通过独立 V/R；新任务 v2 契约、签名批准、默认协议切换、doctor/status 与旧模板兼容已完成定向验收。本机批准密钥丢失须重新批准，最终 Phase 4 Heavy 和真实业务角色仍待后续工单。

- 2026-09-29 TASK-032 隔离角色编排在候选 `7233571` 通过独立 V/R；准备阶段诊断与运行阶段均限制未受信任 Provider 的外部写入，真实 Codex 探针通过。TASK-030/031 在同 HEAD 重绑通过；Phase 4 Heavy 与真实业务角色仍待后续工单。
- 2026-09-29 TASK-036 Spring T2 与 v2 Gate Planner 在 `af57702` 独立 V/R PASS；真实 Maven/Gradle Gate、契约完整性、环境和候选漂移、完整报告清单均定向复核。TASK-030/031/032 在同 HEAD 重绑 PASS；最终波次 Heavy 尚待验收。
- 2026-09-29 TASK-027 执行事件协议在 `e399565` 独立 V/R PASS；并发写入、身份与 Secret 校验、确认等待故障恢复及 Task/Review 主路径已定向验收。FEAT-009 的页面与最终 Heavy 仍在后续工单。
- 2026-09-29 TASK-028 本地执行观察面在 `a53bbba` 正式定向 Gate 3/3、独立技术 V/R 和真实 Chrome 功能通过；TASK-033 v2 角色观察面同一 HEAD 独立技术 V/R 与桌面/390px Chrome 通过。两项当前 revision 的人工视觉仍待用户分别决定，FEAT-009 与 Phase 4 Heavy 尚未关闭。
- 2026-09-29 修复两项观察面共用页眉在 390px 下的工程选择框遮挡；新候选 `03cb2aa` 的 TASK-028 正式定向 Gate 3/3 和两项当前 HEAD 浏览器截图通过。旧 HEAD 的独立 V/R 不作为新候选 PASS；仍待当前候选独立复核与分别进行的人工视觉 Review。
- 2026-09-30 修复观察面在 761–906px 的横向溢出及平板页眉拥挤；候选 `6eef0ca` 的 TASK-028 正式定向 Gate 3/3、两项桌面/390px 浏览器截图与 820/900/921px 宽度回归通过。独立复核和人工视觉仍待完成。
- 2026-09-29 TASK-038 统一本机成品出口在 `eca847d` 独立 Light V/R PASS；点点助手 0.2.0 APK 与源构建物哈希一致。版本目录未入 Git，未声称真机验收或由候选 HEAD 重构。
- 2026-09-29 TASK-039 目标规格 Task 文件名兼容在 `eca847d` 独立 Light V/R PASS；海工 live TASK-001 只有一份带名称规格，运行任务绑定该真实路径。
- 2026-09-29 TASK-040 M linked-worktree Git 管理目录最小写根在 `eca847d` 独立 Light V/R PASS；路径逃逸拒绝、参数去重和 V/R 隔离均定向复核。
- 2026-09-29 TASK-041 候选质量兼容在 `eca847d` 独立 Light V/R PASS；公开示例配置和 CRLF 可用，真实敏感文件与尾随空格继续拒绝。
- 2026-09-29 TASK-042 v2 Controlled V 自动冻结在 `eca847d` 独立 Light V/R PASS；缺失旧 Harness state 可安全生成 collect 证据，漂移和脏树继续拒绝。
- 2026-09-29 TASK-043 仓库 Bash Gate 在 `4366ed8` 独立 Light V/R PASS；完整 P 契约与当前 Run 绑定，实际解释器和 PATH 固定，伪契约及假程序绕过已关闭。真实海工 Gate 和最终 Heavy 仍待各自验证。
- 2026-09-30 TASK-046 全量质量套件并发稳定性缺陷在 `9e95565` 完成定向 Gate 与独立 V/R，形成 Candidate；同 tree 的历史完整 Heavy 为 `7f5cacd` 7/7，新的集成候选仍由 TASK-029 负责复测。
- 2026-09-30 用户撤下飞书功能，FEAT-008 与 TASK-026 已取消，连接器保持禁用；Phase 4 最终 Heavy 改验本地确认路径。第四轮 `36c631a` 全量质量 320/321，固定等待竞态转 TASK-047，第五轮复测中。
- 2026-09-30 第五轮 `4f7fb6e` 七组 Heavy 6/7、Node 320/321，后台视图启动超时转 TASK-048；不同失败根因误合并转 TASK-049。TASK-045 的批准 Contract 依赖修订缺少合法 M 前恢复入口，转 TASK-050 并获 P 批准。第六轮候选 `246cecd` 后续按原 full Gate 复验，旧 HEAD 结论不自动沿用。
- 2026-10-01 第六轮：`246cecd` 七组 Heavy Gate、Node 322/322 与独立 V/R PASS；TASK-045、047～051 已按各自定向 Gate 和独立 V/R 关闭，内嵌占位缺陷归 TASK-051。TASK-049 首次 R 发现指纹数字身份与顺序问题，归 TASK-052，修复在 `b587ed0` 定向 Gate 与独立 V/R PASS。随后集成 `5c3a6d0` 的全量质量套件发现 TASK-053，转第七轮修复；TASK-029 Heavy 决定和 TASK-037 最终阶段验收仍待完成。
- 2026-10-01 第七轮：`5c3a6d0` 全量质量 325/326 的唯一失败归 TASK-053 测试夹具；`8df95df` 受管定向 Gate 2/2、独立 V/R PASS，树相同的最新集成 `c45dea6` 全量质量 326/326、同 TASK-029 七项技术范围均通过。TASK-052/053 已关闭；第七轮 78 条 AC 为 53 PASS、17 BLOCKED、8 NOT_APPLICABLE，343 项技术用例为 342 PASS、1 BLOCKED。固定 `N=6`，目前仅 TASK-029/037 未完成，`R=2` 达到停止门槛；两项最终 Heavy/阶段决定及当前 HEAD 受管重绑仍待用户判断，见[第七轮完整矩阵](../05-delivery/2026-10-01-Phase4-第七轮完整测试矩阵.md)。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 建立产品规格并同步 Phase 1–2 结果 | 按规格模板重组 | TASK-001、TASK-002 |
| 2026-07-12 | 要求每个目标工程维护自身规格库 | 让系统知识进入目标仓库 | TASK-012 |
| 2026-07-23 | 增加人工视觉 Review 与 Playwright Web Gate | 让主观效果确认和真实浏览器功能分别形成可审计证据 | TASK-019 |
| 2026-07-25 | 明确正式验证与阶段推进的授权边界 | 防止 Loop 启动和反馈迭代频繁触发正式交付 | TASK-016 |
| 2026-08-03 | 重新签署 Phase 3 正式交付 | 加固候选通过完整 Evidence 闭环、独立 Verifier 与用户 Heavy 验收 | TASK-013 |
| 2026-08-04 | 起草飞书正式机器人连接器 | 让用户离开本机会话后仍能获知进度并处理受控确认 | TASK-021～026 |
| 2026-08-12 | 起草可重建执行可视化 | 让用户从项目 `.spec-loop/` 直接理解当前工作和历史耗时 | TASK-027～029 |
| 2026-09-30 | 关闭 v2 观察面工单 | TASK-033 在 `6eef0ca` 完成技术 V/R、桌面/窄屏浏览器证据与 Codex 委托视觉判断；FEAT-009 仍待 TASK-029 Heavy | TASK-033 |
| 2026-09-30 | 关闭 report-only v1 Ready 误报缺陷 | TASK-044 在 `78bfd70` 通过受管 targeted Gate 和独立 V/R，v1 非终态可见但不可派发；Phase 4 总体验收仍待 TASK-037 | TASK-044 |

## 2026-10-01 第九轮技术验收同步

第九轮 TASK-037 当前集成候选 `2ebee82` 的 Heavy Gate 8/8、Node 334/334、Playwright 2/2、双 Project 实时 Scheduler 指标与独立 V/R 均 PASS；TASK-029 `3be7123` 自身 Heavy 7/7、独立 V/R PASS。TASK-054～062 的关联缺陷已关闭，飞书保持取消；规格库当前仅 TASK-029、037 未完成，`R=2`，均待用户绑定当前 revision 的最终 Heavy/Phase 4 决定。见[第九轮完整矩阵](../05-delivery/2026-10-01-Phase4-第九轮完整测试矩阵.md)。

## 2026-10-02 最终验收同步

TASK-029 与 TASK-037 的精确候选已获用户最终 Heavy 验收，Phase 4 阶段验收完成；第九轮 50 条 AC 为 42 PASS、8 NOT_APPLICABLE，未完成工单 `R=0`。PROD-001 覆盖 Phase 5 后续目标，因此产品整体继续进行中。 见[最终人工验收记录](../05-delivery/2026-10-02-Phase4-最终人工验收记录.md)。
