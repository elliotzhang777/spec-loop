# TASK-016：定义分级验证范围

- 状态：已完成
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-07-15
- 最后更新：2026-07-15
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)、[DES-006](../03-design/DES-006-engineering-toolchain-adapters.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)、[FEAT-006](../02-feature/FEAT-006-engineering-toolchains.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 任务等级：Light

## 目标

界定低风险反馈、候选版本、正式交付和阶段验收的测试范围，避免图标等局部改动在用户确认前重复触发完整 Harness、全量业务测试和独立 Verifier。

## 工作范围

### 包含

- 定义验证范围选择原则、四种运行时机和升级条件；
- 定义图标、文案、静态资源、局部代码、核心/安全改动的默认验证矩阵；
- 区分快速反馈记录与可用于 Delivery 的正式 Evidence；
- 为 Phase 4 Toolchain Gate Planner 定义输入和输出。

### 不包含

- 本工单不实现自动 diff/依赖分析；
- 不修改 Phase 3 Harness 状态机和 Gate Runner；
- 不降低 Heavy、正式 Release 或阶段验收的既有要求。

## 验收标准

- [x] AC-1：总体架构明确验证范围由改动影响、任务风险和运行时机共同决定。
- [x] AC-2：定义 feedback、candidate、delivery、phase 四级验证及 Evidence 地位。
- [x] AC-3：明确图标等资源改动默认不在每次反馈后运行全量业务测试。
- [x] AC-4：定义验证范围升级条件，禁止无理由全量重复和静默缩小范围。
- [x] AC-5：DES-006 定义未来自动 Gate Planner 的影响分析、选择结果和审计字段。

## 交付记录

- 完成日期：2026-07-15
- 变更文件/交付物：`spec/architecture.md`、FEAT-003、FEAT-006、DES-003、DES-006。
- 关键实现与决策：快速反馈以最小充分检查优先；最终候选稳定且用户确认后，统一运行一次正式交付 Gate。
- 与原设计的差异：原设计只有固定 T1 Gate，没有定义反馈阶段与正式交付阶段的范围边界。
- 遗留风险：Phase 3 仍依赖 Controller 人工判断；自动 Gate Planner 需在 Phase 4 另行授权实现。

## 验证证据

| 日期 | 验证人 | 环境 | 结果 | 证据/输出 |
|---|---|---|---|---|
| 2026-07-15 | Codex | 规格库静态检查 | PASS | 文档链接、层级引用和变更内容检查 |

## 关闭检查

- [x] 验收标准全部通过
- [x] 测试/检查结果已记录
- [x] 设计差异已记录
- [x] 上游实际结果已更新
- [x] 已从两个看板移除

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-07-15 | 建立分级验证范围规范 | 图标类低风险反馈不应重复触发完整交付验证 |
