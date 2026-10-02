# 路线图

> 本文件是 spec-loop 阶段方向的权威定义。具体产品行为、技术方案和执行工作分别下沉到 Product、Feature、Design 和 Task。

系统核心模块、控制链、事实源和安全边界见[系统总体架构](architecture.md)。

## 项目愿景

- 目标用户：希望把多个真实工程任务交给 AI Agent，并获得可验证、可恢复交付的个人开发者与研发团队。
- 核心问题：人在多轮开发中持续补 Prompt、复制错误、提醒验证和判断完成；跨任务、跨项目后状态、权限和成本更加分散。
- 预期价值：用户从“循环内操作员”上移为目标、批准和高风险判断者，spec-loop 管理 Project、Task、Agent 执行、验证、迭代和 Delivery。
- 北极星指标：无需人在循环内追加“继续修复/运行测试”Prompt，且最终通过独立验证的任务比例。

## 当前阶段基线

| 阶段 | 目标结果 | 关联特性 | 状态 |
|---|---|---|---|
| Phase 0 | 建立产品规格和验收基线 | [PROD-001](01-product/PROD-001-local-spec-loop.md) | 已完成 |
| Phase 1 | 单任务文件生命周期、Round、Evidence 和 Delivery | [FEAT-001](02-feature/FEAT-001-file-task-lifecycle.md) | 已完成 |
| Phase 2 | Attempt、Ledger、Budget、Guard、Summary 和失败恢复 | [FEAT-002](02-feature/FEAT-002-runtime-ledger-guard.md) | 已完成 |
| Phase 3 | Project Loop、Codex worktree 单步执行和 T1 Gate | [FEAT-003](02-feature/FEAT-003-project-loop-agent-execution.md) | 已完成 |

## 最终 Phase 3–5

```text
Phase 3：Project Loop 与受控单步执行
    ↓ 稳定并通过两个真实项目 Dogfood
Phase 4：报告型 Scheduling 与批准后的自动闭环
    ↓ 长期运行证明质量、安全和成本
Phase 5：多项目 Portfolio、能力资产和持续优化治理
```

不得跳阶段。后一阶段必须保持前一阶段的全量回归、Heavy Dogfood 和独立验证。

## Phase 3：Project Loop 与受控单步执行（已完成）

### 目标

从“一个任务目录”扩展为“一个工程中的多个可查询、可恢复任务”，并让 Codex 在隔离 worktree 中完成用户明确批准的单步工程工作。

### 产品控制面

- 严格 Project metadata：项目 ID、名称、Git 路径、默认分支/版本、输出位置、风险、可选 Issue 引用。
- 目标工程规格库：在源码仓内维护 Roadmap、Product、Feature、Decision、Design、Task 和验证看板；支持后端主规格库、前端卫星规格库和同仓全栈组合，并提供补建与完整性校验。
- 可重建 Task Registry：按项目、状态和 resumable 查询；Registry 不成为 Task State。
- Project State：原生保存项目目标、候选项、忽略原因和下一步；活跃/阻塞任务与最近 Delivery 从 Task 派生。
- 手动 Triage：只生成 Proposal，不自动创建 Task。
- Proposal Approval：批准绑定 Proposal/Spec hash、批准人、时间、范围和风险。
- Task Delivery 生成 Project 回写摘要；第一版不写外部系统。

### 执行基础

- Provider registry：Codex、Claude Code、Qoder；默认 Codex。
- 第一阶段真实执行只要求 Codex Dogfood，其他 Provider 完成严格配置与 Adapter 合同。
- Harness：`prepare → execute → collect → verify → report`。
- 每个真实代码任务使用独立 worktree/branch，记录 base commit、HEAD 和 touched files。
- T1 通用命令 Gate：argv、cwd、环境 allowlist、timeout、stdout/stderr、exit code、artifact hash 和 Git HEAD。
- Web 任务可使用目标工程本地 Playwright Gate，归档真实浏览器测试统计、HTML 报告、截图和逐文件哈希；视觉 AC 额外进入绑定 revision 的人工效果验收。
- 生命周期仍由用户显式命令推进；不做后台 Scheduling 和自动多 Round Controller。
- 多任务可管理、可查询，但默认串行执行，不实现并发 Worker/Lease。

### 非目标

- 后台 Scheduling；
- 自动批准 Proposal/Task；
- 自动 push/merge/deploy；
- Connector 写权限；
- 多任务并发；
- 无人监督生产修改。

### 完成标准

1. 能按状态、项目和 resumable 查询多个 Task。
2. Registry 可以从 Project/Task 目录删除后重建。
3. Project State 不复制或覆盖 Task State。
4. Triage 只能生成 Proposal；未批准 Proposal 不能成为正式 Task。
5. Codex 在独立 worktree 完成真实工程任务，Evidence 自动绑定实际 HEAD。
6. Delivery 生成可审计 Project 回写摘要。
7. 至少两个真实项目完成 Dogfood。
8. Phase 1–3 全量回归和独立 Verifier 最终 PASS。
9. Web 功能不能以编译或 Agent 自述替代 Playwright；声明视觉 Review 的任务未获用户批准不得交付。

关联：[FEAT-003 Project Loop 与 Agent 执行](02-feature/FEAT-003-project-loop-agent-execution.md)、[FEAT-006 工程 Toolchain](02-feature/FEAT-006-engineering-toolchains.md)。

正式结论：2026-08-03，TASK-013 在候选 `3b05ac59a5d14b21486362ab4179f053eedc6ffb` 上完成 WPHASE3 全量 Gate、独立 Verifier 和用户 Heavy 验收，Phase 3 正式关闭。证据见[阶段三交付报告](05-delivery/阶段三交付报告.md)。

## Phase 4：报告型 Scheduling 与受控自动闭环

> 阶段状态：2026-10-02 已完成最终 Heavy/阶段验收；详见[阶段四交付报告](05-delivery/阶段四交付报告.md)。

> 当前授权：FEAT-008 飞书进度通知与确认连接器已于 2026-08-04 获准实施；FEAT-009 可重建执行可视化的核心实现已于 2026-08-12 获准实施；FEAT-004 的 TASK-030 P/M/V/R v2 旁路内核已于 2026-08-31 获准实施。2026-09-04，用户批准将剩余工单统一对齐最新版 P/M/V/R v2 架构并开始实施，范围为 TASK-027～037 的规格、实现和快速反馈检查。2026-09-26 用户批准已批准 Task 范围、权限、Gate 计划与预算内的实现和正式 V/R 连续修复复验；HEAD 变化重新绑定证据，不重复申请执行授权。2026-09-30 用户将用户级推进改为完整规格库轮次；随后明确撤下飞书功能，TASK-026 取消，Phase 4 只保留本地确认路径。Heavy/视觉/阶段验收及 merge、push、deploy 等动作仍需明确决定，集中进入轮次裁决清单。

### 历史规格库轮次：2026-10-01 第八轮未完成工单收口

第二轮起始扫描整个 `spec/04-task/`，共有 6 个未完成工单：原 5 个加第一轮 report-only Ready 误报缺陷 TASK-044。TASK-028 已在本轮完成 v1 Delivery，第二轮续执行又将 Proposal 占位误判建立为 TASK-045，TASK-033 委托视觉收口后新建 TASK-046 后当前仍剩 6 项。状态以各工单和[待完成看板](pending-board.md)为准。

| 工单 | 当前状态 | 本轮可推进项 | 仍需的条件或决定 |
|---|---|---|---|
| [TASK-029](04-task/TASK-029-execution-view-hardening.md) | 已完成 | 历史过程见本表；当前 `3be7123` 已完成最终 Heavy 验收 | [最终人工验收记录](05-delivery/2026-10-02-Phase4-最终人工验收记录.md) |
| [TASK-026](04-task/TASK-026-feishu-heavy-dogfood.md) | 已取消 | 用户撤下飞书功能；历史代码与证据保留且连接器禁用 | 不再计入当前验收 |
| [TASK-037](04-task/TASK-037-phase4-pmvr-heavy-dogfood.md) | 已完成 | 历史过程见本表；当前 `2ebee82` 已完成最终 Heavy/Phase 4 验收 | [最终人工验收记录](05-delivery/2026-10-02-Phase4-最终人工验收记录.md) |
| [TASK-054](04-task/TASK-054-approved-existing-task-adoption.md) | 已批准、受管 P 已导入 | 隔离修复通过 Project 定向测试，已将 TASK-037 成功导入 | TASK-029 当前 Gate 后执行 Standard M/V/R |
| [TASK-055](04-task/TASK-055-supervisor-timeout-recovery-test-circuit.md) | 已批准、受管 P 已导入 | 隔离修复 Scheduler 8/8 PASS、TASK-029 已纳入新候选 | 当前 Heavy Gate 后执行 Standard M/V/R |
| [TASK-044](04-task/TASK-044-report-only-v1-false-ready.md) | 已完成 | `78bfd70` 受管 targeted 4/4、独立 V/R PASS，Candidate 已形成 | 本工单关闭；Phase 4 总体验收由 TASK-037 承担 |
| [TASK-045](04-task/TASK-045-proposal-unknown-domain-term.md) | 已完成 | `8ed8b89` targeted 2/2、独立 V/R PASS；Contract v2 审计修订完成 | 本工单关闭 |
| [TASK-046](04-task/TASK-046-quality-suite-concurrency-stability.md) | 已完成 | `7f5cacd` Heavy 7/7、Node 321/321；`9e95565` targeted 2/2、独立 V/R PASS | 新集成候选完整回归归 TASK-029 |
| [TASK-047](04-task/TASK-047-fast-exit-identity-test-race.md) | 已完成 | `70688bb` targeted 2/2、独立 V/R PASS；集成 Heavy 7/7 | 本工单关闭 |
| [TASK-048](04-task/TASK-048-execution-view-startup-under-load.md) | 已完成 | `75a9c91` targeted 2/2、独立 V/R PASS；集成 Heavy 7/7 | 本工单关闭 |
| [TASK-049](04-task/TASK-049-controlled-gate-failure-fingerprint.md) | 已完成 | `b587ed0` targeted 2/2、独立 V/R PASS；第一次 R FAIL 保留 | 本工单关闭 |
| [TASK-050](04-task/TASK-050-unstarted-v2-contract-correction.md) | 已完成 | `b25019b` targeted 2/2、独立 V/R PASS；TASK-045 Contract v2、missing_data=0 | 本工单关闭 |
| [TASK-051](04-task/TASK-051-embedded-proposal-placeholders.md) | 已完成 | TASK-045 新 HEAD 覆盖内嵌占位缺陷，定向 Gate 和独立 V/R PASS | 本工单关闭 |
| [TASK-052](04-task/TASK-052-controlled-gate-fingerprint-identity-order.md) | 已完成 | TASK-049 新 HEAD 定向 Gate 与独立 V/R PASS；`c45dea6` 全量质量 326/326 | 本工单关闭 |
| [TASK-053](04-task/TASK-053-v1-report-fixture-round-placeholder.md) | 已完成 | `8df95df` 受管 Gate 2/2、独立 V/R PASS；同 tree 集成 `c45dea6` 全量质量 326/326 | 本工单关闭 |

实施按依赖顺序进行，独立可执行项不等待阻塞项；集成冻结候选后集中执行适用的 targeted Gate、各批准 Heavy Gate、独立 V/R 与人工裁决。TASK-028 已按 v1 原协议交付，未迁移；原 P4-B1～B4 仅作为历史和内部资源分组。现有 Scheduler Wave 不是跨规格库轮次的一键执行器。

第一轮 [完整测试矩阵](05-delivery/2026-09-30-Phase4-完整轮次测试矩阵.md)覆盖原 5 个工单的 48 条目标 AC，T037-AC-3 的真实扫描失败建成 TASK-044。第二轮[完整矩阵](05-delivery/2026-09-30-Phase4-第二轮完整测试矩阵.md)覆盖 6 个工单、51 条 AC；隔离组合候选 `49612eb` 的 336 个技术用例/场景全部通过。[续执行记录](05-delivery/2026-09-30-Phase4-第二轮续执行记录.md)记载 TASK-028 Delivery 和 TASK-044 targeted Gate，续执行增加 TASK-045 三条 AC 后按[第三轮完整矩阵](05-delivery/2026-09-30-Phase4-第三轮完整测试矩阵.md)盘点 57 条，第三轮历史结论为 23 PASS、1 FAIL、33 BLOCKED。第四轮 TASK-044 的 3 条 AC 已在 `78bfd70` 通过受管 M/V/R；其他工单仍按前置条件推进。

第三轮最终候选[逐用例结果](05-delivery/2026-09-30-Phase4-第三轮最终候选逐用例结果.json)记录技术 338 项：337 PASS、1 FAIL。第四轮[完整矩阵](05-delivery/2026-09-30-Phase4-第四轮完整测试矩阵.md)按飞书撤项和新 TASK-047 盘点 60 条 AC；[逐用例结果](05-delivery/2026-09-30-Phase4-第四轮最终候选逐用例结果.json)为 336 PASS、2 FAIL，分别归 TASK-047 的固定等待竞态和 TASK-045 的 Contract 历史依赖。第五轮在新 HEAD 重跑完整适用矩阵。

第五轮集成 HEAD `4f7fb6e` 的 TASK-029 Heavy 仍为 6/7，Node 320/321、Playwright 2/2；第四轮快退出用例已过，新的后台视图启动超时转 [TASK-048](04-task/TASK-048-execution-view-startup-under-load.md)。不同失败根因被 Controller 合并为重复指纹转 [TASK-049](04-task/TASK-049-controlled-gate-failure-fingerprint.md)，受管 Conflict 已保留并按用户连续推进授权审计解决。第六轮在新 HEAD 重跑，旧候选的 PASS 不自动沿用。

2026-09-30 用户补充连续轮次收口条件：以此刻全规格库的 6 个未完成工单为固定起点，后续缺陷工单计入剩余量；每轮完整验证后，剩余工单严格少于起始数的 10% 或严格少于 3 个时，停止自动推进并提交全部剩余问题供用户决定。TASK-026 已取消，TASK-044～053 已完成；第七轮 78 条 AC 为 53 PASS、17 BLOCKED、8 NOT_APPLICABLE，343 项逐技术用例为 342 PASS、1 BLOCKED。当前仅 TASK-029、037 未完成，`R=2`，达到绝对数停止门槛，详情见[第七轮完整矩阵](05-delivery/2026-10-01-Phase4-第七轮完整测试矩阵.md)。

2026-10-01 用户将后续停止条件改为全库未完成工单 `R=0` 且适用验收全部通过，要求继续解决 TASK-029、037。第七轮曾按旧规则停止的记录保留为历史；当前 `R=2`，继续推进，不以旧数量门槛收口。

第八轮 TASK-037 P onboarding 发现 TASK-054：已批准且未绑定的目标工单无法导入受管控制面，已建缺陷工单和 P Proposal；当前 `R=3`。TASK-029 的新集成候选 `03f68a0` 已完成受管 M、四条浏览器路径及当前 revision 视觉 Review，正在重跑独立 V；TASK-037 波次 Review GUI 当前代码树技术路径 PASS、真实 Spring Boot 定向 2/2 PASS，首次无持久库配置的目标工程全量失败已单独留痕，不冒充本工单 Heavy PASS。

TASK-029 该轮正式 V 结束后，7 项 Gate 6 PASS、1 FAIL；全量 Node 326 项 325 PASS、1 FAIL。恢复用例与 Supervisor 熔断条件冲突，新增 [TASK-055](04-task/TASK-055-supervisor-timeout-recovery-test-circuit.md) 并保留受管 Conflict，当前 `R=4`。按完整规格库下一轮修复与复验，不以其他六项 PASS 替代全量结论。

TASK-055 的 P Proposal `PROP-24`/批准 `APR-26` 已受管导入；其隔离修复 Scheduler 测试 8/8 PASS。TASK-054 隔离修复 Project 测试 10/10 PASS。两项仍需正式受管验证，当前 `R=4`。TASK-029 新 M 遇到 Codex CLI 当前账号不支持其全局配置模型，已在本 Project Provider 配置中选用实测可运行的 `gpt-6-sol` 并恢复启动探针，不改用户全局配置。

随后 TASK-054 已由 `PROP-23`/`APR-25` 导入；其修复 CLI 成功将 `PROP-22`/`APR-24` 的已批准 TASK-037 原规格导入受管控制面，状态和 AC 未改。TASK-029 新候选 `3be7123` 的八张截图当前视觉 Review 已通过，正式完整 V Gate 正在运行。TASK-054、055、037 仍待各自适用正式验证，`R=4`。

### 目标

在 Project Loop 稳定后，引入只报告 Scheduling、用户批准门禁、自动单任务 Controller、受控并发、Maker/Checker、安全控制和最小权限 Connector。

### 先报告后执行

1. Scheduler 初期只运行 Triage 并生成发现、重复项、风险和成本报告。
2. 观察误报率、采纳率和成本后，才允许用户批准的 Proposal 进入自动执行。
3. Approval 必须绑定内容 hash、范围、风险和有效期；内容变化使批准失效。

### 自动单任务闭环

- P 在规格/Task 创建时同步形成 AC、用例、工具、断言和证据要求并由人批准；
- M 在受控 Worktree 实现、自测并提交稳定 HEAD；
- Controller 从契约、HEAD、diff 和工程 Toolchain 编译不可降级的验收计划；
- V 独立执行 Playwright、API、单测等验收并分类实现、环境、规格和高风险失败；
- V PASS 后 R 才能独立复核结论与 Evidence，R 不替代 V 执行测试；
- 在途单任务 M/V/R 保留原有语义返工预算；用户级规格库轮次先推进具备条件的实现，再集成冻结候选、集中运行批准的 Gate 与 V/R，失败项统一归类进入下一轮；基础设施重试不得绕过各 Task 的既有预算；
- 预算耗尽或冲突生成 Conflict Record/Review Inbox 并进入 `waiting_human_review`；
- 普通独立 Task 可暂挂并继续其他 Ready Task，下游、关键路径和高风险任务按规则阻塞或立即升级。

### 隔离与调度

- 所有自动代码修改强制 worktree/branch；
- Project run lease、task lease、fencing token 和幂等键；
- 无冲突任务可受控并发，冲突资源串行；
- Pause 不启动新动作；Kill 取消执行并保留现场，恢复前 reconcile；
- 单任务预算和全局预算。

### Toolchain 与 Connector

- T2 平台预设按需求增加：Spring Boot、Xcode/iOS、微信小程序。
- Connector 权限按只读 → 评论/标签 → 有限状态更新逐级开放。
- 当前 Phase 4 不启用飞书连接器；已完成的历史实现保留并保持禁用。人工决定使用本地 `needs_user`、Review 与受控确认入口。
- 默认禁止自动 merge、删除、生产数据、凭据、签名和发布修改。

### 本地只读观察面

- 每个 Project 可以从自身 `.spec-loop/` 重建当前 Task、当前步骤、历史步骤、耗时和 Evidence 路径，不建立第二 Task 状态源。
- 旧运行事实缺少起止时间时必须显示精度和缺口；新增步骤使用追加式执行事件补齐准确时间，不得依赖文件 mtime 猜测。
- 首版只提供本机回环地址的只读 Web 页面，不借可视化入口扩大 Controller、Connector 或文件写权限。

### 完成标准

1. Scheduling 完成足够的 report-only 试运行，误报率、采纳率和成本可观察。
2. 用户批准后，一个 Standard 和一个 Heavy 任务无需循环内人工 Prompt 自动闭环。
3. 所有自动代码修改均隔离，Maker/Checker 强制分离；Heavy 额外人工检查。
4. Pause/Kill、预算、Denylist、冲突检测、审计和恢复有效。
5. Connector 遵循最小权限，不自动合并、不默认写生产环境。
6. 多个低风险真实任务 Dogfood delivered。
7. 独立功能和安全验收 PASS，Phase 1–3 全量回归通过。
8. 本地 `needs_user`、Review 和 Heavy 确认完成身份、幂等、重启恢复和人工决定边界 Dogfood；飞书实测不属于当前完成标准。

关联：[FEAT-004 受控自动闭环](02-feature/FEAT-004-controlled-automation.md)、[FEAT-005 Scheduling 与隔离](02-feature/FEAT-005-scheduling-isolation.md)、[FEAT-006 工程 Toolchain](02-feature/FEAT-006-engineering-toolchains.md)、[FEAT-009 可重建执行可视化](02-feature/FEAT-009-execution-visualization.md)。

## Phase 5：Portfolio、能力资产与持续优化治理

### 目标

在多个可靠 Project Loop 上建立只读可重建 Portfolio、跨项目排序建议、可复用能力资产、长期指标和受控优化流程。

### 项目组合

- 聚合项目、任务、进度、阻塞、风险、预算、依赖、冲突、Delivery 和自动化运行情况。
- Portfolio 只能从 Project State/Task/运行事实重建，不能成为新的状态事实源。
- 跨项目排序考虑用户优先级、依赖、风险、成本、收益、截止时间和资源冲突。
- 建议必须解释输入和权重，用户可以覆盖并形成审计记录。

### 能力资产

管理经过验证的 Protocol、Skill、Triage、Verifier、Eval、Harness Adapter、Toolchain Adapter、Connector、模板和安全策略。每项资产必须有版本、content hash、来源、owner、适用范围、所需权限、评测、Provider/Toolchain 兼容性、回滚和替代关系。

### 指标与优化

- 成功率、首轮通过率、平均 Round、人工介入率；
- Triage 误报/采纳率；
- Token/工作量、交付周期、回滚率；
- 指标必须说明来源、时间窗口、缺失值和是否可跨项目比较。

优化只能遵循：

```text
历史事实 → Proposal → 独立 Eval → 人工批准 → 灰度 → 观察 → 推广或回滚
```

系统不得自动修改核心协议、安全策略、Denylist 或 Connector 权限。

### 跨项目隔离

- 项目不共享凭据；
- 敏感数据不进入全局 Portfolio；
- Memory/History 按项目隔离；
- Connector 按项目授权；
- 可复用资产不能携带项目私有数据。

### 完成标准

1. Portfolio 可从 Project State 和任务事实删除后重建。
2. 排序建议可解释、可覆盖、可审计。
3. 能力资产有版本、评测、权限和回滚信息。
4. 优化只能生成 Proposal，并经独立评测和人工批准。
5. 项目数据、Memory、Connector 和凭据默认隔离。
6. 自动化收益有长期真实数据证明。
7. 独立架构、安全和隐私审查 PASS，Phase 1–4 全量回归通过。

关联：[FEAT-007 Portfolio 与持续优化](02-feature/FEAT-007-portfolio-capability-optimization.md)。

## 能力维度

| 维度 | 当前 | Phase 3 | Phase 4 | Phase 5 |
|---|---|---|---|---|
| 任务治理 | Light/Standard/Heavy | 保持 | 保持 | 保持 |
| 自动化 | A0 协议控制 | A1 单步执行 | A2 自动单任务 + A3 受控多任务 | A3 Portfolio 治理；A4 仍需单独授权 |
| Toolchain | T0 外部 Evidence | T1 通用命令 + Playwright Web Gate | T2/T3 平台预设、自动发现与原生证据 | 适配器资产治理 |
| Delivery | D0 本地记录 | D0/D1 本地 commit 可选 | D2 draft PR 需批准 | D3 不因 Portfolio 自动获得 |

## 路线图变更规则

- Phase 3 已于 2026-08-03 正式完成；Phase 4 仍必须获得单独实施授权，不因 Phase 3 完成而自动启动。
- Phase 4 必须长期 report-only 和真实低风险运行稳定后才能开始 Phase 5。
- 每个 Phase 建立独立 Heavy Task，包含 SPEC、AC、风险、自动测试、真实 Dogfood、独立 Verifier 和正式 Delivery。
- 后续能力不得削弱已有 Task State、Ledger、Guard、Evidence、Heavy 门禁和恢复要求。

## 2026-10-01 第九轮技术验收同步

Phase 4 第九轮技术候选 `2ebee82` 已完成批准的 8/8 Heavy Gate、Node 334/334、Playwright 2/2、独立 V/R；TASK-029 独立 Heavy 候选 `3be7123` 7/7、独立 V/R。最终用户 Heavy/Phase 4 阶段决定仍待作出，Phase 5 未启动。见[第九轮完整矩阵](05-delivery/2026-10-01-Phase4-第九轮完整测试矩阵.md)。

## 2026-10-02 Phase 4 最终验收

用户接受 TASK-029 `3be7123` 的最终 Heavy，以及 TASK-037 `2ebee82` 的最终 Heavy 与 Phase 4 阶段结果。第九轮最终矩阵 42 PASS、0 BLOCKED、8 NOT_APPLICABLE、0 FAIL；全规格库未完成工单 `R=0`，满足用户要求的停止条件。见[最终人工验收记录](05-delivery/2026-10-02-Phase4-最终人工验收记录.md)。Phase 5 尚未获准启动；2026-10-02 精确候选 `2ebee82` 已快进合入本地主分支，远端与外部部署状态见[阶段四交付报告](05-delivery/阶段四交付报告.md)。

## 2026-10-02 Phase 5 进入条件核对

用户要求继续推进后，先完成 Phase 4 交付后缺陷 TASK-063：已合入 Candidate 不再误报 `baseline_drift`，定向测试与独立 V/R PASS，当前未完成工单 `R=0`，见[缺陷验收矩阵](05-delivery/2026-10-02-Phase4-交付后缺陷验收矩阵.md)。Phase 5 的两工程 report-only 当日核对通过，但现有快照仅覆盖 2026-09-30、10-01、10-02，缺少长期稳定与收益证据；FEAT-007/DES-007 仍为草稿，不提前启动 Phase 5 实现。见[进入条件核对](05-delivery/2026-10-02-Phase5-进入条件核对.md)。
