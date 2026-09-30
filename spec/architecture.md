# Spec-Loop 系统总体架构

> 本文是 Spec-Loop 技术架构的最高层权威说明。Roadmap 定义阶段方向，Product 定义产品目标，本文定义系统模块、控制链、事实源和安全边界；各专项 Design 负责具体实现方案。

## 系统定位

Spec-Loop 位于用户、Agent 和目标工程之间，把一次工程任务组织成可控制、可验证、可恢复的闭环。

```text
用户
  ↓ 目标、批准、关键决策、最终验收
Spec-Loop 控制面
  ↓ 规格、状态、调度、预算和门禁
Agent 执行与独立验证
  ↓ 受控修改、测试和检查
目标工程与 Git
  ↓ 代码事实
Evidence 与 Delivery
```

Spec-Loop 不是新的编码模型，也不替代目标工程的代码和规格库。它负责控制 Agent 如何进入工程、如何执行、如何接受反馈以及如何证明交付。

## 核心模块

工程闭环由五个核心模块和两个基础支撑组成。

| 模块 | 核心职责 | 不负责什么 |
|---|---|---|
| P / Controller | 在规格与 Task 创建时形成 AC、用例、工具、断言和证据契约；获人批准后编译计划、路由失败和控制预算 | 不在实现后降低验收语义，不直接用自述替代验证 |
| M / Maker | 在批准范围和受控 Worktree 中修改代码、自测并提交稳定 HEAD | 不修改 Approval、验收契约、Gate 配置或最终结论 |
| Gate | 执行确定性的构建、测试和检查，记录退出码、超时、artifact 和 HEAD | 不判断产品体验或自行修改代码 |
| V / Verifier | 按绑定 contract/HEAD/diff/toolchain/environment 的计划独立验收并分类失败 | 不修改候选，不与 M 共用结论上下文 |
| R / Reviewer | 在 V PASS 后独立复核 V 结论、覆盖和证据链，并决定是否形成 Candidate | 不替 V 跑测试，不修改候选或 V Evidence |
| Guard | 根据预算、连续失败、重复错误和无进展情况决定 continue、needs_user 或 stop | 不决定产品范围和高风险授权 |
| Spec/AC | 定义目标、范围、非目标和可验证验收标准 | 不随实现结果任意降低标准 |
| Evidence | 保存绑定 Task、Round、revision 和 artifact 哈希的验证事实 | 不接受 Agent 自述作为完成证明 |

人工视觉 Review 是横跨 Spec/AC、Gate 与 Delivery 的显式卡点，不由受控 Worktree 中的 Maker、Gate 或 Verifier 代签。UI 或视觉 AC 声明 Review 后，用户必须通过可信 Controller 查看当前候选截图并作出批准或拒绝；决定绑定 Round、revision、截图文件和 SHA-256。代码或截图变化后旧批准自动失效。Phase 3 是本机单用户工具，CLI 的 `--by` 只做审计归属，不承担操作系统身份认证；可信边界是主控制目录及其外层会话/文件权限，获得同一用户主控制目录写权限的恶意进程不在本阶段威胁模型内。Phase 4 的飞书 Connector 使用企业自建应用、单租户绑定和允许用户映射提供远程身份，但仍必须经过本地 Approval/Review/Verification/Delivery Guard。

## 主控制链

```text
P：规格 + Task + 完整验收契约 → 人批准
        ↓
M：实现 + 自测 → 稳定 HEAD
        ↓
Controller：按 contract + HEAD + diff + toolchain + environment 编译计划
        ↓
V：独立工具验收
    ├─ implementation → M
    ├─ infrastructure → 有界重试
    └─ spec/high-risk → human
        ↓ PASS only
R：独立复核 V 结论与 Evidence
    ├─ implementation → M
    ├─ evidence       → V
    ├─ spec           → human
    └─ pass           → Evidence Gate → Candidate
        ↓ 预算耗尽/重复失败
waiting_human_review + Conflict Record + Review Inbox
```

Loop 不是同一个 Agent 反复尝试并自行宣布完成，而是 Controller 根据 V/R 独立反馈持续纠正偏差。M、Gate、V、R 和 Guard 的职责分离，是避免自我验收的核心条件。协议 v2 使用旁路运行工件；已开始的 v1 Task 不自动迁移、不重启，旧 `VERIFY.md` 生命周期继续可读。

### 当前工单到最新版架构的映射

| 架构层 | 工单 |
|---|---|
| v1 兼容事实底座 | TASK-027 执行事件、TASK-028 本地观察面 |
| v2 状态机内核 | TASK-030 Contract/Plan/V/R/预算/Conflict/Candidate |
| P 契约与新任务接入 | TASK-031 |
| M/V/R 物理隔离和 Controller 调度 | TASK-032 |
| v2 执行事件与观察面 | TASK-033 |
| report-only 与受控 Scheduling | TASK-034、TASK-035 |
| Gate Planner 与首个 T2 Toolchain | TASK-036 |
| 专项与 Phase 最终 Heavy | TASK-026、TASK-029、TASK-037 |

TASK-027/028 已经开始，因此按 v1 完成并由后续 v2 Heavy 工单复核；TASK-026 尚未进入 Round，TASK-029 和 TASK-031～037 均按 P/M/V/R v2 创建或重写。

## 验证范围与运行时机

验证范围由“改动影响、任务风险、当前时机”共同决定，不按历史 Task 数量机械展开，也不要求每次用户反馈后都运行完整交付闭环。

| 时机 | 目的 | 默认范围 | Evidence 地位 |
|---|---|---|---|
| 快速反馈检查 | 尽快生成可试用结果，发现直接错误 | 与改动直接相关的静态检查、编译、定向测试或 smoke test | 临时反馈记录，不能单独支持 Delivery |
| 候选版本检查 | 确认一个已提交、可复验的候选版本 | 受影响模块测试、必要集成测试、构建和风险检查 | 必须绑定干净工作树和当前 HEAD，可进入本 Round Evidence |
| 正式交付 Gate | 证明最终候选满足批准的 AC | Task 验证计划要求的完整 Gate、独立 Verifier；Heavy 再加人工确认 | 可用于 AC→Evidence 映射和 Delivery |
| 阶段/跨模块验收 | 证明阶段能力和兼容性 | 明确要求的历史阶段全量回归、对抗测试和 Dogfood | 仅在阶段工单或高影响变更中运行 |

### 规格库轮次中的验证去重

同一规格库轮次中的各 Task 使用定向 Gate 并产生局部 Evidence；“Task 完整 Gate”只表示完整覆盖该 Task 的 AC、改动模块和直接依赖，不表示重跑整轮或项目。可执行实现集成、候选冻结后，由适用的已批准 Heavy 工单运行必要的跨 Task 全量组合 Gate；重合范围不重复运行。不得在每个 Task Delivery 中机械重放已交付 Task 的全套 Gate。

轮次测试矩阵须从全部未完成 Task 的 AC、批准的 Gate/用例、Web 路径、人工 Review 和适用的历史阶段回归生成。Gate 原始报告保留每个测试用例的结果与候选绑定；逐 AC 索引不能代替内部测试用例明细。测试阶段完成可执行用例后将确认的代码失败按根因建立缺陷 Task；下一轮对新候选重测完整适用矩阵，且同一候选的重叠 Gate 仍按原去重规则只运行一次。阻塞、跳过和人工待决不计为 PASS。

共享 API、数据库迁移、权限、安全、并发、依赖或构建基础发生变化时，可以按依赖扩大到相关子系统；扩大原因必须具体记录。无法证明影响范围时才按批准计划 fail safe 到全量，不能以“更保险”为由重复全量验证。Task Evidence 只能证明局部 AC，只有适用 Heavy/阶段 Evidence 才能声明组合能力可进入下一阶段。

`GATES.md` 的 `scope_kind: task | wave` 和 `wave_id` 仍是现有 Gate 协议的内部层级，不代表用户级轮次。`coverage: targeted | full` 明确声明实际覆盖：Light/Standard Task 只能使用 `targeted`，`wave` 必须使用 `full` 且只允许独立 Heavy Task。每个 Gate 必须声明覆盖的本 Task AC，Gate Result 和 Harness Report 继续保存并复核原层级、覆盖类型与 AC 映射。

### 验证数据库生命周期

工程应提供一个长期验证数据库，普通 Task 在 `GATES.md` 声明
`database.lifecycle: persistent`，通过事务回滚、固定 Fixture 或受控
schema reset 恢复测试基线。Gate 不得反复执行容器的创建、删除或数据卷销毁；
Harness 会把数据库生命周期和重置方式写入 Gate Evidence 与 Report，并向目标命令
注入 `SPEC_LOOP_DATABASE_LIFECYCLE`、`SPEC_LOOP_DATABASE_RESET`。

只有迁移、首次初始化、升级/回滚或必须从零证明隔离性的 Heavy 验证，才可声明
`database.lifecycle: disposable`，同时记录明确原因。一次性数据库是有理由的
例外，不是每个 Task 的默认测试环境。

### 验证阶段与轮次授权

验证范围扩大条件只决定“技术上需要跑什么”，不能扩大已批准 Task 的权限、Gate 计划或预算。当前协作流程遵守：

1. 已批准 Task 的执行授权覆盖范围、权限、Gate 计划和预算内的实现、自测、正式 V/R 与失败修复；“只看反馈”之类明确限定的请求仍只做快速反馈。
2. 轮次纳入全部未完成 Task 的盘点，不为未批准 Task、外部副作用、生产写入或额外预算创造授权。
3. 候选内容变化使旧 HEAD 的 PASS、Evidence 绑定和视觉决定失效；在原授权范围内集成、重建 Evidence 和复验，不逐候选要求重新批准。
4. 正式 Delivery、人工视觉、Heavy、阶段完成及合并、推送、发布须在轮次裁决中得到各自明确决定；一个决定不自动代替另一个。
5. 进入下一阶段不能从 Task Delivery 推导，必须核对全部必要前置与独立阶段决定。

没有对应 Task 执行授权或所需外部条件时，不因它出现在完整清单而启动受控动作。安全事件可以暂停受影响范围并请求用户决定，但不能借此扩大授权。

默认影响范围：

- 纯文档：格式、链接、Schema 和规格一致性检查；
- 图标、文案、静态资源或局部样式：资源有效性、目标构建和定向视觉/smoke 检查；默认不运行全量业务测试；
- 局部业务代码：受影响单元测试、相邻集成测试和目标构建；
- 公共接口、核心控制链、数据模型/迁移、并发、安全、权限、依赖或构建系统：扩大到相关子系统或全量回归；
- 最终 Release、Heavy Delivery 或阶段验收：按已批准验证计划执行完整 Gate。

出现以下任一情况必须升级验证范围：无法可靠判断影响、改动跨越多个模块、触及持久化/安全/权限/并发/公共契约、定向测试失败、测试或 Gate 配置被修改、候选版本将在外部发布。升级原因必须记录，不能以“更保险”为由无条件重复全量测试。

快速反馈阶段允许工作树尚未提交，但不得生成声称绑定当前提交的正式 Release Evidence。进入轮次集中验证前必须先形成稳定提交；任何后续代码或资源提交都会使旧 HEAD Evidence 失效。在已批准 Task 范围内先集成同轮修改，再运行其正式 Gate；人工接受和 Delivery 仍按轮次裁决执行。

Web 系统的功能验证使用 Playwright 专用 Gate，而不是把任意 `npm test` 输出称为浏览器证据。Gate 只执行目标 worktree 中由 Git 跟踪锁文件约束的 Playwright CLI，强制生成 JSON、HTML 和适用附件；视觉路径必须生成至少一张可完整解码的 PNG，纯功能路径可显式关闭截图要求。零测试、unexpected、flaky、skipped、超时、缺报告、缺少声明为必需的截图、附件哈希变化、完整 Gate Plan 变化或候选内容指纹变化均为失败。Playwright 负责可重复的真实浏览器功能路径，人工视觉 Review 负责布局、密度、层级、观感等主观效果；包含视觉 AC 时两者缺一不可。

## Worktree 与 Harness

Worktree 是物理目录和 Git 分支层面的隔离工作场地；Harness 是绑定该场地的受控执行流程。

```text
Task
  ↓ 一对一绑定当前执行 Workspace
Worktree
  ↓ 承载一次或多次执行
Harness Run
  ├─ prepare
  ├─ execute
  ├─ collect
  ├─ verify
  └─ report
```

- Worktree 决定在哪里、基于哪个 commit 修改代码；
- Harness 决定谁可以执行、按什么顺序执行、如何超时、如何收集和验证；
- Gate 在同一个 Worktree 中运行；
- Evidence 必须绑定该 Worktree 的真实 HEAD；
- 当前 Phase 3 一项 Task 固定绑定一个 Worktree，并保存一套当前 Harness 状态；完整的多 Run 不可覆盖归档仍需后续增强。

Worktree 只隔离代码目录和 Git 分支，不隔离用户权限、网络、Keychain、系统剪切板和操作系统进程。Harness、Approval 和命令门禁用于补充执行边界，但不等同于容器或虚拟机。

## 权威事实源

| 事实 | 权威位置 | 说明 |
|---|---|---|
| 代码和版本历史 | 目标工程 Git 仓库 | Spec-Loop 不复制为第二代码源 |
| 产品与技术规格 | 目标工程 `spec/` | Roadmap、Product、Feature、Design、Task |
| 当前任务状态 | `TASK_STATE.md` | CLI 管理的唯一生命周期状态 |
| 状态完整性轨迹 | `STATE_HISTORY.jsonl` | 用于检测非法状态跳转和手工分歧 |
| Attempt 历史 | `LOOP_LEDGER.jsonl` | Run Log 和 Summary 都由它重建 |
| 执行时间与步骤观测事实 | `EXECUTION_EVENTS.jsonl` | 追加式时间事件；不覆盖 Task/Harness/Evidence 的结果事实 |
| 当前执行现场 | Workspace Manifest、Worktree、Harness State | 绑定 Task、base、branch、cwd 和 HEAD |
| 验证事实 | Evidence artifact 与 metadata | 绑定 Round、revision、退出码和哈希 |
| 项目和任务列表 | Project metadata 与可重建 Registry | Registry 不是第二状态源 |
| 最终交付 | Delivery 的 AC→Evidence 映射 | 只能引用当前有效 Evidence |

## 规格与运行数据边界

一个被管理项目使用项目容器组织代码和控制数据：

```text
projects/<project>/
├── repo/
│   ├── .git/
│   ├── 业务代码
│   └── spec/          长期产品与技术规格
└── .spec-loop/        Proposal、Approval、Task、运行状态和 Evidence
```

`repo/spec/` 保存系统长期为什么这样设计；`.spec-loop/` 保存某次任务具体如何执行。两者可以位于同一个项目容器，但不进入同一个 Git 工作树。

## Spec-Loop 工程物理布局

```text
spec-loop/
├── src/            当前产品源码
├── test/           当前自动化与对抗测试
├── assets/         运行时必须随 npm 包交付的非代码资产
├── spec/           产品、架构、工单和交付事实源
│   └── 05-delivery/ 按 Phase 保存不可改写的历史报告、Evidence 和 Dogfood
└── 根配置        README、AGENT、npm 与 TypeScript 配置
```

根目录不再并列展示历史 `artifacts/` 和 `dogfood/`。它们属于已交付或已撤回阶段的只读证据，按 Phase 归档到 `spec/05-delivery/`。`dist/`、`node_modules/`、`.spec-loop/` 和事务目录是可重建或运行时状态，不进入 Git 事实源。

## 阶段职责演进

| 模块 | Phase 3 | Phase 4 | Phase 5 |
|---|---|---|---|
| Controller | 当前对话中的主控 Agent 手动协调 | Spec-Loop 自动单任务 Controller | Portfolio Controller 负责跨项目建议，单项目仍由 Phase 4 Controller 执行 |
| Maker | Harness 启动的 Codex Agent | Controller 调度的独立 Maker Agent | 不变，由各项目 Controller 调度 |
| Gate | Spec-Loop T1 确定性命令 | Spec-Loop Toolchain/Gate 自动运行 | 不变，并作为能力资产治理 |
| Verifier | 主控启动独立 Agent或会话，结果接入 Evidence | Controller 调度独立 Checker Agent | 不变，由各项目闭环执行 |
| Guard | Spec-Loop 自动判断预算和失败门限 | 自动决定继续、停止或请求用户 | 增加项目和 Portfolio 级预算治理 |
| 最终验收 | 用户 | 用户处理最终确认、高风险和 needs_user | 用户处理跨项目优先级和最终决策 |

最简演进关系：

```text
Phase 3：对话主控负责调度，系统负责受控执行和记录
Phase 4：自动 Controller 替代人工逐步推进单任务闭环
Phase 5：增加多项目 Portfolio 治理和受控持续优化
```

## 安全与权限边界

- 未批准 Proposal 不能创建或执行正式 Task；
- Approval 绑定内容哈希、批准人、scope、风险和有效期；
- Maker 只能在受控 Worktree 中修改业务代码；
- Gate 使用固定 cwd、受限环境、timeout 和危险命令禁令；
- Maker 与 Verifier 分离，Heavy 任务额外要求人工检查；
- Guard 控制失败、无进展、Token 和工作量预算；
- Evidence 必须绑定当前 Task、Round 和 Git HEAD；
- 默认禁止自动 push、merge、deploy、publish 和生产修改；
- 无法确定现场时必须 reconcile 或进入 needs_user，不猜测成功。

## 专项设计索引

| 专项设计 | 负责范围 |
|---|---|
| [DES-001](03-design/DES-001-file-contract-lifecycle-acceptance.md) | 文件契约、Task 状态机、Round、验收与 Delivery |
| [DES-002](03-design/DES-002-ledger-guard-recovery.md) | Attempt Ledger、Budget、Guard、摘要和原子恢复 |
| [DES-003](03-design/DES-003-project-loop-agent-harness.md) | Project Control Plane、Approval、Worktree、Gate 和 Harness |
| [DES-004](03-design/DES-004-controlled-automation-controller.md) | 自动单任务 Controller、Maker/Checker 和失败分类 |
| [DES-005](03-design/DES-005-scheduling-worktree-coordination.md) | Scheduling、Lease、并发、Pause/Kill 和 Connector |
| [DES-006](03-design/DES-006-engineering-toolchain-adapters.md) | 通用命令和平台 Toolchain Adapter |
| [DES-009](03-design/DES-009-execution-visualization.md) | 执行事件、可重建投影与本地只读观察面 |
| [DES-007](03-design/DES-007-portfolio-capability-governance.md) | Portfolio、能力资产、指标与持续优化治理 |
| [DES-008](03-design/DES-008-feishu-bot-connector.md) | 飞书正式机器人、进度投影、交互确认、身份、恢复与审计 |

## 阅读顺序

```text
README
→ Product
→ Roadmap
→ 本总体架构
→ 对应 Feature
→ 对应专项 Design
→ 对应 Task 与 Evidence
```

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 建立系统总体架构文档 | 将跨模块职责和阶段演进提升到技术最高层 | TASK-015 |
| 2026-07-15 | 增加分级验证范围与运行时机 | 避免低风险反馈重复触发完整 Harness 和全量回归 | TASK-016 |
| 2026-07-26 | 增加波次 Task 增量验证与最终一次组合 Heavy | 避免 W1～W4 每个 Task 重复运行整个波次回归 | TASK-016 |
| 2026-07-26 | 强制非 Heavy 定向 Gate 与长期验证数据库 | 消除普通 Task 全量回归和数据库容器反复创建销毁 | TASK-016 |
| 2026-07-19 | 明确工程物理布局与按 Phase 交付归档 | 将当前工程与历史证据分层 | TASK-018 |
| 2026-07-25 | 增加验证阶段显式升级授权 | 防止把 Task 启动、继续修改或效果图反馈误判为正式交付 | TASK-016 |
| 2026-08-04 | 定义飞书正式机器人远程交互边界 | 让用户远程获知进度并处理必要卡点，同时保持本地事实源和 fail-closed 授权 | TASK-021～026 |
| 2026-09-30 | 用户级推进改为完整规格库轮次 | 集成后集中验证与裁决，避免逐 Task/逐波次请求及重复 HEAD 证据绑定；保留现有 Gate/Wave 协议 | TASK-026、028、029、033、037 |
