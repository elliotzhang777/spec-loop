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
| Controller | 读取目标、状态和反馈，决定下一步是执行、修复、重规划、重试、找人或交付 | 不直接用自述替代测试和验证 |
| Maker | 在批准范围和受控 Worktree 中修改代码、补充测试 | 不修改 Approval、验收标准、Gate 配置或最终结论 |
| Gate | 执行确定性的构建、测试和检查，记录退出码、超时、artifact 和 HEAD | 不判断产品体验或自行修改代码 |
| Verifier | 独立检查实现、测试和 Evidence 是否满足规格，主动寻找遗漏和越权 | 原则上不直接修复实现，不与 Maker 共用结论上下文 |
| Guard | 根据预算、连续失败、重复错误和无进展情况决定 continue、needs_user 或 stop | 不决定产品范围和高风险授权 |
| Spec/AC | 定义目标、范围、非目标和可验证验收标准 | 不随实现结果任意降低标准 |
| Evidence | 保存绑定 Task、Round、revision 和 artifact 哈希的验证事实 | 不接受 Agent 自述作为完成证明 |

人工视觉 Review 是横跨 Spec/AC、Gate 与 Delivery 的显式卡点，不由受控 Worktree 中的 Maker、Gate 或 Verifier 代签。UI 或视觉 AC 声明 Review 后，用户必须通过可信 Controller 查看当前候选截图并作出批准或拒绝；决定绑定 Round、revision、截图文件和 SHA-256。代码或截图变化后旧批准自动失效。Phase 3 是本机单用户工具，CLI 的 `--by` 只做审计归属，不承担操作系统身份认证；可信边界是主控制目录及其外层会话/文件权限，获得同一用户主控制目录写权限的恶意进程不在本阶段威胁模型内，远程身份认证留给 Phase 4 Connector。

## 主控制链

```text
目标与已批准规格
        ↓
    Controller
        ↓
      Maker
        ↓
  Git Collect + Gate
        ↓
  Visual Review（按 AC 要求）
        ↓
     Verifier
        ↓
    Controller
    ├─ repair       进入下一轮修复
    ├─ replan       更新计划后重新执行
    ├─ retry        Provider 或环境重试
    ├─ needs_user   请求用户决策
    ├─ stop         达到安全或预算边界
    └─ delivery     Evidence 满足 AC 后交付
```

Loop 不是同一个 Agent 反复尝试并自行宣布完成，而是 Controller 根据独立反馈持续纠正偏差。Maker、Gate、Verifier 和 Guard 的职责分离，是避免自我验收的核心条件。

## 验证范围与运行时机

验证范围由“改动影响、任务风险、当前时机”共同决定，不按历史 Task 数量机械展开，也不要求每次用户反馈后都运行完整交付闭环。

| 时机 | 目的 | 默认范围 | Evidence 地位 |
|---|---|---|---|
| 快速反馈检查 | 尽快生成可试用结果，发现直接错误 | 与改动直接相关的静态检查、编译、定向测试或 smoke test | 临时反馈记录，不能单独支持 Delivery |
| 候选版本检查 | 确认一个已提交、可复验的候选版本 | 受影响模块测试、必要集成测试、构建和风险检查 | 必须绑定干净工作树和当前 HEAD，可进入本 Round Evidence |
| 正式交付 Gate | 证明最终候选满足批准的 AC | Task 验证计划要求的完整 Gate、独立 Verifier；Heavy 再加人工确认 | 可用于 AC→Evidence 映射和 Delivery |
| 阶段/跨模块验收 | 证明阶段能力和兼容性 | 明确要求的历史阶段全量回归、对抗测试和 Dogfood | 仅在阶段工单或高影响变更中运行 |

### 波次开发的验证去重

一个业务波次（例如 W1）拆成多个 Task 时，“Task 完整 Gate”只表示完整覆盖该 Task 的 AC、改动模块和直接依赖，不表示重跑整个波次或项目。各 Task 使用增量 Gate 并产生局部 Evidence；波次所有 Task 合入后，再由独立阶段工单运行一次跨 Task 全量组合 Heavy。不得在每个 Task Delivery 中机械重放已交付 Task 的全套 Gate。

共享 API、数据库迁移、权限、安全、并发、依赖或构建基础发生变化时，可以按依赖扩大到相关子系统；扩大原因必须具体记录。无法证明影响范围时才 fail safe 到波次全量，不能以“更保险”为由重复全量验证。波次 Task Evidence 只能证明局部 AC，只有最终阶段 Evidence 才能声明整个波次可进入下一阶段。

`GATES.md` 使用 `scope_kind: task | wave` 记录本轮层级，并可用 `wave_id` 绑定 W1 等业务波次。`coverage: targeted | full` 明确声明实际覆盖：Light/Standard Task 只能使用 `targeted`，`wave` 必须使用 `full` 且只允许独立 Heavy Task。启用分层范围后，每个 Gate 必须声明覆盖的本 Task AC，Gate Result 和 Harness Report 会保存并复核层级、波次、覆盖类型与 AC 映射。命令本身是否真正属于受影响模块仍由 Controller 的影响分析负责，Phase 4 再演进自动 Gate Planner。

### 验证数据库生命周期

工程应提供一个长期验证数据库，普通 Task 在 `GATES.md` 声明
`database.lifecycle: persistent`，通过事务回滚、固定 Fixture 或受控
schema reset 恢复测试基线。Gate 不得反复执行容器的创建、删除或数据卷销毁；
Harness 会把数据库生命周期和重置方式写入 Gate Evidence 与 Report，并向目标命令
注入 `SPEC_LOOP_DATABASE_LIFECYCLE`、`SPEC_LOOP_DATABASE_RESET`。

只有迁移、首次初始化、升级/回滚或必须从零证明隔离性的 Heavy 验证，才可声明
`database.lifecycle: disposable`，同时记录明确原因。一次性数据库是有理由的
例外，不是每个 Task 的默认测试环境。

### 验证阶段升级授权

验证范围扩大条件只决定“技术上需要跑什么”，不能代替用户对运行时机的授权。Controller 必须遵守：

1. Task/Loop 启动授权只覆盖实现和 `feedback`，不自动覆盖 `delivery` 或 `phase`。
2. “继续”“修改”“预览”“出效果图”“打开看看”和用户拒绝效果，均不得解释为正式交付授权。
3. 进入 `delivery` 前，用户必须针对当前反馈批次明确要求“进入正式验证”“进入正式交付”“跑完整 Gate”或作出同义指令；授权和候选 revision 必须记录。
4. 授权为当前候选单次有效。视觉拒绝、功能反馈或任何候选内容变化都会使它失效，Controller 必须退回 `feedback`，不得机械重跑完整 Gate。
5. 进入 `phase`、签署阶段完成或推进下一阶段需要独立确认，不能从 Task Delivery 推导。

没有明确升级授权时，即使 Task 为 Heavy、完整 Gate 已配置或上一次候选曾进入 Delivery，Controller 也必须停留在快速反馈检查。安全事件可以暂停工作并请求用户决定，但不能借此自行扩大到正式交付。

默认影响范围：

- 纯文档：格式、链接、Schema 和规格一致性检查；
- 图标、文案、静态资源或局部样式：资源有效性、目标构建和定向视觉/smoke 检查；默认不运行全量业务测试；
- 局部业务代码：受影响单元测试、相邻集成测试和目标构建；
- 公共接口、核心控制链、数据模型/迁移、并发、安全、权限、依赖或构建系统：扩大到相关子系统或全量回归；
- 最终 Release、Heavy Delivery 或阶段验收：按已批准验证计划执行完整 Gate。

出现以下任一情况必须升级验证范围：无法可靠判断影响、改动跨越多个模块、触及持久化/安全/权限/并发/公共契约、定向测试失败、测试或 Gate 配置被修改、候选版本将在外部发布。升级原因必须记录，不能以“更保险”为由无条件重复全量测试。

快速反馈阶段允许工作树尚未提交，但不得生成声称绑定当前提交的正式 Release Evidence。进入候选版本检查前必须先形成稳定提交；任何后续代码或资源提交都会使旧 HEAD Evidence 失效。用户确认体验且明确授权进入正式验证后，Controller 应合并同一反馈批次，只运行一次正式交付 Gate。

Web 系统的功能验证使用 Playwright 专用 Gate，而不是把任意 `npm test` 输出称为浏览器证据。Gate 只执行目标 worktree 本地安装的 Playwright CLI，强制生成 JSON、HTML 与至少一张可完整解码的 PNG 截图；零测试、unexpected、flaky、skipped、超时、缺报告、缺截图、附件哈希变化或候选内容指纹变化均为失败。Playwright 负责可重复的真实浏览器功能路径，人工视觉 Review 负责布局、密度、层级、观感等主观效果，两者缺一不可。

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
| [DES-007](03-design/DES-007-portfolio-capability-governance.md) | Portfolio、能力资产、指标与持续优化治理 |

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
