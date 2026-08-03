# DES-003：Project Control Plane 与 Agent Harness

- 状态：已完成
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-08-03
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)

## 设计目标

覆盖 Project metadata、可重建 Task Registry、Project State、Triage Proposal/Approval、Delivery 回写，以及 Codex worktree 单步执行和 T1 Gate。

系统级模块职责、完整控制链、事实源和 Phase 3～5 演进统一定义在[系统总体架构](../architecture.md)；本文只定义 Project Control Plane、Worktree、Gate 和 Harness 的专项方案。

## 现状与约束

- 现状：Phase 1–2 只有独立 Task 目录，工作由外部人/Agent 完成。
- 技术约束：Task State 和 Ledger 继续是事实源；Provider CLI 参数按本机版本验证。
- 不在范围：Scheduler、自动多 Round、并发 Worker、push/merge、Connector 写入。

## 方案概览

```text
Project Metadata ─┬→ Task Directory Scan → Rebuildable Registry
Project State ────┤
Target Repo spec/ ┤→ Product / Feature / Design / Task
Manual Triage → Proposal → Approval → Task
                                      ↓
Provider Registry → Codex Harness → Worktree → T1 Gates → Evidence
                                                   ↓
Task Delivery → Project Write-back Summary
```

## 详细设计

### 项目元数据

严格 Schema 包含 project ID/name、repository、spec root、default branch/version、task/output root、risk 和外部 Issue 引用。目标仓库是代码事实源。

### 目标工程规格库

`project init` 必须把规格库写入目标源码仓，使规格与实现进入同一个 Git 候选。兼容配置 `standard` 继续使用仓库根 `spec/`；新版可选择 `backend`、`frontend` 或 `fullstack`：后端维护主规格库，前端维护只引用上游事实的卫星规格库，全栈仓在 `backend/` 与 `frontend/` 下同时初始化。已有文件保持不变；`project spec-init` 只补缺，`project spec-check` 对缺失、空文件、非法规格或目录越界失败。批准 Proposal 创建正式 Task 时，`TASK-*` 与 `WEB-TASK-*` 分别写入配置对应的源码规格目录。`.spec-loop` 只保存控制状态，不复制或替代源码仓规格。

### 项目状态

原生字段：current goal、candidate proposals、ignored findings/reasons、next action。派生字段：active/blocked tasks、recent Delivery、任务统计。派生字段不允许独立编辑为 Task 状态。

### 任务注册表

从任务目录读取 task ID、path、state、level、Round、state version 和 Delivery revision。重复 ID、坏路径和状态不一致时报错。缓存可以删除重建。

### Proposal 与 Approval

Proposal 包含来源、建议目标、目标工程、风险、优先级、初始 AC 和理由。Approval 记录 proposal/spec hash、批准人/时间、范围、风险和有效期；内容变化后失效。

### Provider 与 Harness

Provider ID 为 codex/claude-code/qoder，默认 Codex。统一 Adapter 执行 inspect/invoke/cancel。Harness 五步固定：prepare、execute、collect、verify、report。collect 重新计算 Git diff、HEAD 和 touched files，不完全信任 Agent 自报。

### Worktree 与 T1 Gate

每个执行 Task 独立 branch/worktree，记录 base commit。Gate 使用 argv、固定 cwd、环境 allowlist 和 timeout，Evidence 记录命令、退出码、artifact hash、duration、Round 和真实 HEAD。

### 验证时机与 Harness 边界

Controller 在每次验证前记录 `verification_stage`、touched files、影响模块、任务风险、计划 Gate 和升级理由。Phase 3 由主控人工判断；Phase 4 由 Toolchain Gate Planner 生成建议，Controller 仍对最终范围负责。

- `feedback`：用于用户快速试用。只运行资源校验、目标编译、定向测试或 smoke；不要求完整 `prepare → execute → collect → verify → report`，结果不能直接签署 Delivery。
- `candidate`：改动已经提交且工作树干净。运行受影响模块与必要集成 Gate，Evidence 必须绑定当前 HEAD。
- `delivery`：用户反馈批次结束，最终候选稳定。运行 Task 已批准的完整 Gate、独立 Verifier 和必要 Heavy 人工检查。
- `phase`：仅阶段工单显式触发，运行跨 Task/跨阶段全量回归、对抗测试和真实 Dogfood。

同一业务波次内，普通 Task 的 `delivery` 只运行该 Task 的完整验证计划：自身 AC、改动模块和直接依赖。它不得因为波次中已经存在其他 Task，就重放这些 Task 的完整 Gate。波次结束时由独立阶段工单进入 `phase`，只运行一次跨 Task 全量组合 Heavy；只有该阶段 Evidence 可以声明整个波次通过。

该边界由 Gate 配置强制表达：Light/Standard Task 只能使用
`coverage: targeted`；`coverage: full` 仅允许 Heavy Task，`scope_kind: wave`
还必须绑定 `wave_id`。Gate Result 与 Harness Report 同时绑定 coverage，防止用局部
Evidence 冒充全量，也防止普通 Task 无意运行整套回归。

数据库验证默认复用工程长期实例：`database.lifecycle: persistent` 搭配
transaction、fixtures 或 schema reset，Gate 禁止直接创建/删除 Docker/Podman
容器。只有迁移、初始化、升级/回滚或隔离证明类 Heavy 验证可以声明
`disposable`，且必须记录原因。Harness 把策略注入目标命令并写入 Evidence，
使项目脚本也能据此禁止每轮创建、删除数据库。

Task/Loop 启动和“继续执行”只进入实现与 `feedback`。Controller 不得把“改一下”“出效果图”“打开看看”、效果拒绝或旧的 Task 授权解释为 `delivery` 授权。只有用户对当前稳定候选明确要求进入正式验证、正式交付或运行完整 Gate 后，才允许启动完整 Harness；候选变化会立即消费并作废这次授权。`phase` 还需要独立的阶段确认。

图标、文案、静态资源和局部样式属于低风险资源改动：默认执行资源格式/尺寸检查、目标应用构建、包内资源检查及人工视觉确认。除非同时触及构建配置、签名、公共代码或发布边界，否则不在每次反馈后运行全量业务测试。用户确认并明确授权进入正式验证后，正式 Delivery Gate 才按 Task 计划统一执行一次。

Harness Report 必须注明实际运行的验证层级和 Gate 集合。未运行的 Gate 不能伪造为 PASS；缩小范围不降低 AC，扩大范围必须有明确触发原因。

### 人工视觉 Review

`ACCEPTANCE.md` 可声明一个或多个必需的 `human_reviews`，当前实现支持 `kind: visual`。声明及其 AC 覆盖在 `plan` 时用 Acceptance 哈希冻结到 CLI 管理的 Task State、Plan 和状态历史，不能在执行中删除或降级。Review 请求只接受通过 CRC、压缩流、尺寸和扫描行完整校验的 PNG，复制到 Task 控制目录并记录 SHA-256；请求绑定 Task、Round、目标仓库真实 Git commit 和 Acceptance。人工通过或拒绝写入当前投影和带连续哈希链的历史，Verification 会以历史重建决定，不单独信任投影文件。以下任一条件会阻断 `verify --result pass` 与 Delivery：

- 必需 Review 未请求、仍 pending 或已 rejected；
- Review Round 或 revision 与当前候选不一致；
- Acceptance、请求 hash、决定历史、截图文件、媒体内容或截图 hash 不一致；
- 必需 Review 没有绑定已有 AC。

批准后的 Review ID 会写入本轮原生 Evidence；Delivery 中视觉 AC 必须映射到包含该 Review ID 的 Evidence。视觉 Review 判断布局、密度、层级和整体效果；确定性 Gate 与独立 Verifier 继续判断功能和工程质量，二者不能互相代替。Phase 3 通过受控 Worktree 与主控制目录隔离 Maker，Reviewer 字段用于审计而非本机身份认证；具备同一 OS 用户控制目录写权限的进程属于可信边界，Phase 4 Connector 再提供远程身份与交互卡片签名。

### 恢复

Harness 每步有 prepared/running/succeeded/failed/unknown；崩溃后 reconcile Git、worktree 和 artifact，无法确定时 needs_user。

## 方案取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Phase 3 管理多任务但串行执行 | Project 能力先成立，复杂度受控 | 暂无并发收益 | 采用 |
| Phase 3 直接并发 | 更快 | Lease/冲突/恢复范围过大 | 延后 Phase 4 |
| Codex 直接改主工作区 | 简单 | 污染和不可回滚 | 拒绝，最小 worktree 提前 |

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| Registry 变第二状态源 | 状态分叉 | rebuild-only + no direct mutation | 删除重建 |
| Provider 越权 | 控制文件/代码污染 | worktree、Policy、diff 检查 | 丢弃 worktree，回退 A0 |
| Project State 复制 Task | 项目摘要陈旧 | 派生查询 | 重新生成摘要 |

## 验证策略

| 验收范围 | 验证层级 | 方法 | 预期结果 |
|---|---|---|---|
| Project/Registry | E2E/对抗 | 删除重建、重复 ID、状态损坏 | 正确重建或严格失败 |
| Proposal/Approval | E2E | 未批准/过期/hash 变化 | 禁止创建 Task |
| Codex Harness | E2E | 两个真实项目、worktree、T1 Gate | delivered + HEAD Evidence |
| Failure | 故障注入 | timeout/crash/schema failure | 状态不损坏、可 reconcile |

## 工单拆分

Phase 3 原型由 TASK-004～TASK-012 实现；TASK-013 补充 Workspace/Gate/Report 安全门禁、Harness 状态机与 reconcile、Approval 有效期、跨根事务、规格检查和对抗测试；TASK-016 定义分级验证范围；TASK-017 将目标工程模板从内联字符串统一为版本化资产，并修复自托管检查暴露的契约漂移；TASK-018 将历史 Evidence/Dogfood 按 Phase 归档并收敛工程根目录；TASK-019 增加人工视觉 Review 和 Playwright Web Gate；TASK-020 补齐分工程规格模板路由与版本锁定。上述范围已通过 TASK-013 最终 Heavy 验收。

## 实际实现

- 最终实现：`src/project.ts`、`src/target-spec.ts`、`assets/target-spec/`、`src/execution.ts`、`src/review.ts` 及 CLI Project/Task/Triage/Provider/Workspace/Gate/Harness/Review/Writeback 命令；目标规格初始化、补建和检查共享版本清单，v1～v4 发布内容由 `releases.json` 摘要锁定。
- 安全收口：Gate 对 shell/dispatcher、解释器 inline/preload 和包管理器前置参数绕过采取 fail-closed；Harness Report 绑定 Task、worktree、base、HEAD、Gate artifact 与哈希，并支持持久状态恢复。
- 与设计差异：Phase 3 未引入持久 Registry 缓存，而是每次扫描重建；符合不形成第二状态源的要求。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 融合 Project Loop 与 Provider 执行设计 | 最终 Roadmap | - |
| 2026-07-12 | 将 Loop 核心角色和阶段演进迁移到总体架构 | 避免专项设计承担系统级权威定义 | TASK-015 |
| 2026-07-15 | 定义 feedback/candidate/delivery/phase 四级验证 | 避免低风险反馈重复触发完整 Harness | TASK-016 |
| 2026-07-26 | 定义业务波次 Task 增量验证与最终一次 phase Heavy | 避免每个 Task 重复整个波次回归 | TASK-016 |
| 2026-07-26 | 固化定向覆盖与长期数据库复用 | 非 Heavy 禁止全量验证，普通 Gate 不再反复创建和删除数据库容器 | TASK-016 |
| 2026-07-19 | 增加版本化目标规格模板资产 | 消除独立模板库与 Project 初始化逻辑的双重事实源 | TASK-017 |
| 2026-07-19 | 将历史 Evidence/Dogfood 按 Phase 归档并收敛根目录 | 区分当前工程结构与历史验证现场 | TASK-018 |
| 2026-07-23 | 增加 revision-bound 人工视觉 Review | 效果验收必须由用户对当前截图明确签署 | TASK-019 |
| 2026-07-25 | 正式验证改为显式、候选单次授权 | 防止视觉反馈循环频繁触发完整 Harness | TASK-016 |
| 2026-08-03 | 完成加固版独立 Heavy 验收 | 证明状态机、安全边界、恢复和 Evidence 闭环满足 Phase 3 完成标准 | TASK-013 |
