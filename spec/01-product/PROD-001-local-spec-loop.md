# PROD-001：本地规格驱动任务闭环

- 状态：进行中
- 负责人：zhangbo
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- Roadmap：[roadmap.md](../roadmap.md)

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

## 特性拆分

| Feature | 价值 | 优先级 | 状态 |
|---|---|---|---|
| [FEAT-001 文件驱动生命周期](../02-feature/FEAT-001-file-task-lifecycle.md) | 建立任务契约、状态、验收和 Delivery | P0 | 已完成 |
| [FEAT-002 运行账本与 Guard](../02-feature/FEAT-002-runtime-ledger-guard.md) | 多轮失败可记录、限制和恢复 | P0 | 已完成 |
| [FEAT-003 Project Loop 与 Agent 执行](../02-feature/FEAT-003-project-loop-agent-execution.md) | 管理项目多任务并让 Codex 受控单步执行 | P1 | 已完成 |
| [FEAT-004 受控自动闭环](../02-feature/FEAT-004-controlled-automation.md) | 批准后替代循环内重复 Prompt | P1 | 草稿 |
| [FEAT-005 Scheduling 与隔离](../02-feature/FEAT-005-scheduling-isolation.md) | 报告型调度、并发隔离和安全控制 | P1 | 草稿 |
| [FEAT-006 工程 Toolchain](../02-feature/FEAT-006-engineering-toolchains.md) | 自动构建、测试并生成平台证据 | P2 | 草稿 |
| [FEAT-007 Portfolio 与持续优化](../02-feature/FEAT-007-portfolio-capability-optimization.md) | 多项目组合、能力资产和优化治理 | P2 | 草稿 |

## 实际结果

- 最终结果：Phase 1–3 已交付，支持 Project Loop、Codex worktree 单步执行和 T1 Gate。
- 指标结果：自动化测试通过；Phase 1–2 和两个 Phase 3 真实 Project Dogfood delivered。
- 遗留事项：Scheduling、自动多 Round、受控并发、平台 Toolchain 和 Portfolio 尚未实现。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 建立产品规格并同步 Phase 1–2 结果 | 按规格模板重组 | TASK-001、TASK-002 |
| 2026-07-12 | 要求每个目标工程维护自身规格库 | 让系统知识进入目标仓库 | TASK-012 |
