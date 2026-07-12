# Roadmap

> 本文件是 spec-loop 阶段方向的权威定义。具体产品行为、技术方案和执行工作分别下沉到 Product、Feature、Design 和 Task。

## 项目愿景

- 目标用户：希望把多个真实工程任务交给 AI Agent，并获得可验证、可恢复交付的个人开发者与研发团队。
- 核心问题：人在多轮开发中持续补 Prompt、复制错误、提醒验证和判断完成；跨任务、跨项目后状态、权限和成本更加分散。
- 预期价值：用户从“循环内操作员”上移为目标、批准和高风险判断者，spec-loop 管理 Project、Task、Agent 执行、验证、迭代和 Delivery。
- 北极星指标：无需人在循环内追加“继续修复/运行测试”Prompt，且最终通过独立验证的任务比例。

## 已完成基础

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

### Product Control Plane

- 严格 Project metadata：项目 ID、名称、Git 路径、默认分支/版本、输出位置、风险、可选 Issue 引用。
- 目标工程规格库：在业务仓库内维护 Roadmap、Product、Feature、Design、Task 和验证看板，并提供补建与完整性校验。
- 可重建 Task Registry：按项目、状态和 resumable 查询；Registry 不成为 Task State。
- Project State：原生保存项目目标、候选项、忽略原因和下一步；活跃/阻塞任务与最近 Delivery 从 Task 派生。
- 手动 Triage：只生成 Proposal，不自动创建 Task。
- Proposal Approval：批准绑定 Proposal/Spec hash、批准人、时间、范围和风险。
- Task Delivery 生成 Project 回写摘要；第一版不写外部系统。

### Execution Foundation

- Provider registry：Codex、Claude Code、Qoder；默认 Codex。
- 第一阶段真实执行只要求 Codex Dogfood，其他 Provider 完成严格配置与 Adapter 合同。
- Harness：`prepare → execute → collect → verify → report`。
- 每个真实代码任务使用独立 worktree/branch，记录 base commit、HEAD 和 touched files。
- T1 通用命令 Gate：argv、cwd、环境 allowlist、timeout、stdout/stderr、exit code、artifact hash 和 Git HEAD。
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
8. Phase 1–2 全量回归和独立 Verifier 最终 PASS。

关联：[FEAT-003 Project Loop 与 Agent 执行](02-feature/FEAT-003-project-loop-agent-execution.md)、[FEAT-006 工程 Toolchain](02-feature/FEAT-006-engineering-toolchains.md)。

## Phase 4：报告型 Scheduling 与受控自动闭环

### 目标

在 Project Loop 稳定后，引入只报告 Scheduling、用户批准门禁、自动单任务 Controller、受控并发、Maker/Checker、安全控制和最小权限 Connector。

### 先报告后执行

1. Scheduler 初期只运行 Triage 并生成发现、重复项、风险和成本报告。
2. 观察误报率、采纳率和成本后，才允许用户批准的 Proposal 进入自动执行。
3. Approval 必须绑定内容 hash、范围、风险和有效期；内容变化使批准失效。

### 自动单任务闭环

- Spec Analyst、Planner、Plan Reviewer；
- step-scoped Maker；
- Deterministic Gate Runner；
- 独立 Checker；
- Acceptance Judge 只能引用现有 Evidence；
- Controller 将失败分类为 repair、replan、provider retry 或 needs_user；
- Guard 自动决定是否开启下一 Round。

### 隔离与调度

- 所有自动代码修改强制 worktree/branch；
- Project run lease、task lease、fencing token 和幂等键；
- 无冲突任务可受控并发，冲突资源串行；
- Pause 不启动新动作；Kill 取消执行并保留现场，恢复前 reconcile；
- 单任务预算和全局预算。

### Toolchain 与 Connector

- T2 平台预设按需求增加：Spring Boot、Xcode/iOS、微信小程序。
- Connector 权限按只读 → 评论/标签 → 有限状态更新逐级开放。
- 默认禁止自动 merge、删除、生产数据、凭据、签名和发布修改。

### 完成标准

1. Scheduling 完成足够的 report-only 试运行，误报率、采纳率和成本可观察。
2. 用户批准后，一个 Standard 和一个 Heavy 任务无需循环内人工 Prompt 自动闭环。
3. 所有自动代码修改均隔离，Maker/Checker 强制分离；Heavy 额外人工检查。
4. Pause/Kill、预算、Denylist、冲突检测、审计和恢复有效。
5. Connector 遵循最小权限，不自动合并、不默认写生产环境。
6. 多个低风险真实任务 Dogfood delivered。
7. 独立功能和安全验收 PASS，Phase 1–3 全量回归通过。

关联：[FEAT-004 受控自动闭环](02-feature/FEAT-004-controlled-automation.md)、[FEAT-005 Scheduling 与隔离](02-feature/FEAT-005-scheduling-isolation.md)、[FEAT-006 工程 Toolchain](02-feature/FEAT-006-engineering-toolchains.md)。

## Phase 5：Portfolio、能力资产与持续优化治理

### 目标

在多个可靠 Project Loop 上建立只读可重建 Portfolio、跨项目排序建议、可复用能力资产、长期指标和受控优化流程。

### Portfolio

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
| Toolchain | T0 外部 Evidence | T1 通用命令 | T2/T3 平台预设和原生证据 | 适配器资产治理 |
| Delivery | D0 本地记录 | D0/D1 本地 commit 可选 | D2 draft PR 需批准 | D3 不因 Portfolio 自动获得 |

## 路线图变更规则

- Phase 3 已正式 Delivery；Phase 4 仍需另行建立并批准 Heavy 主工单后才能开始。
- Phase 4 必须长期 report-only 和真实低风险运行稳定后才能开始 Phase 5。
- 每个 Phase 建立独立 Heavy Task，包含 SPEC、AC、风险、自动测试、真实 Dogfood、独立 Verifier 和正式 Delivery。
- 后续能力不得削弱已有 Task State、Ledger、Guard、Evidence、Heavy 门禁和恢复要求。
