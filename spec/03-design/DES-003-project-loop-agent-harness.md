# DES-003：Project Control Plane 与 Agent Harness

- 状态：待验证
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-15
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

`project init` 默认在目标仓库建立 `spec/`，包含 Roadmap、Product、Feature、Design、Task 模板和两个看板。已有文件保持不变；`project spec-init` 只补缺，`project spec-check` 对缺失或空模板失败。批准 Proposal 创建正式 Task 时，同步在目标工程 `spec/04-task/` 写入目标、AC、风险和控制任务引用。目标工程规格随业务代码进入 Git，`.spec-loop` 不复制或替代它。

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

图标、文案、静态资源和局部样式属于低风险资源改动：默认执行资源格式/尺寸检查、目标应用构建、包内资源检查及人工视觉确认。除非同时触及构建配置、签名、公共代码或发布边界，否则不在每次反馈后运行全量业务测试。用户确认后，正式 Delivery Gate 仍按 Task 计划统一执行一次。

Harness Report 必须注明实际运行的验证层级和 Gate 集合。未运行的 Gate 不能伪造为 PASS；缩小范围不降低 AC，扩大范围必须有明确触发原因。

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

Phase 3 原型由 TASK-004～TASK-012 实现；TASK-013 补充 Workspace/Gate/Report 安全门禁、Harness 状态机与 reconcile、Approval 有效期、跨根事务、规格检查和对抗测试；TASK-016 定义分级验证范围；TASK-017 将目标工程模板从内联字符串统一为版本化资产，并修复自托管检查暴露的契约漂移。正式结论等待独立 Heavy 验收。

## 实际实现

- 最终实现：`src/project.ts`、`src/target-spec.ts`、`assets/target-spec/`、`src/execution.ts` 及 CLI Project/Task/Triage/Provider/Workspace/Gate/Harness/Writeback 命令；目标规格初始化、补建和检查共享版本清单。
- 与设计差异：Phase 3 未引入持久 Registry 缓存，而是每次扫描重建；符合不形成第二状态源的要求。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 融合 Project Loop 与 Provider 执行设计 | 最终 Roadmap | - |
| 2026-07-12 | 将 Loop 核心角色和阶段演进迁移到总体架构 | 避免专项设计承担系统级权威定义 | TASK-015 |
| 2026-07-15 | 定义 feedback/candidate/delivery/phase 四级验证 | 避免低风险反馈重复触发完整 Harness | TASK-016 |
| 2026-07-19 | 增加版本化目标规格模板资产 | 消除独立模板库与 Project 初始化逻辑的双重事实源 | TASK-017 |
