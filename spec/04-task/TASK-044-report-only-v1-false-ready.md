# TASK-044：Report-only 不得把 v1 壳标为可派发 Ready

- 状态：已批准
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-30
- 最后更新：2026-09-30
- 所属设计：[DES-005](../03-design/DES-005-scheduling-worktree-coordination.md)
- 所属特性：[FEAT-005](../02-feature/FEAT-005-scheduling-isolation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-034（已完成）
- 任务等级：Light
- 协议版本：P/M/V/R v2
- 来源轮次：2026-09-30 第一轮
- 工单类型：缺陷

## 目标

Report-only 的 `ready` 只表示当前受控 Scheduler 可派发；在途 v1 工单和只作历史索引的 v1 壳仍可列在报告中，但应明确标成需人工流程、不可自动派发。

## 工作范围

### 包含

- 修复 `src/report-scheduler.ts` 对 v1 `resumable` 的 Ready 判定；
- 加入 v1 planned 壳和在途 working Task 的回归，保留 v2 Ready、Review hold、角色 invocation 和报告 canonical/隐私边界；
- 用当前 spec-loop Project 的真实报告复核 TASK-026/028，不触发执行。

### 不包含

- 启动 TASK-026 v1 Round 或自动迁移协议；
- 改写受控 Scheduler 的派发、Lease 或用户级轮次规则；
- 更改已完成 TASK-034 的历史验收记录。

## 验收标准

- [ ] AC-1：v1 `planned`、`working` 等非终态仍可作为报告建议列出，但 `ready=false`，原因明确为 v1 需人工兼容流程；不得显示“可派发”。
- [ ] AC-2：合法 v2 Ready、依赖阻塞、待审 Review hold 和运行中的角色 invocation 判定不回退；重复扫描仍 canonical 等价、无 Task 写入或私有信息泄漏。
- [ ] AC-3：当前 spec-loop 报告中的 TASK-026 v1 历史壳与 TASK-028 在途 v1 均非 Ready；受控 `run-ready` 只读预览也不派发二者。

## 验证计划

| AC | 用例或检查 | 预期 |
|---|---|---|
| AC-1 | `test/report-scheduler.test.mjs` 新增 v1 planned/working fixture | 两项列出，`ready=false`，原因准确 |
| AC-2 | 报告调度器定向测试和直接依赖测试 | v2 Ready/hold/invocation、canonical、安全边界通过 |
| AC-3 | 本仓库两次 report-only 扫描与 `scheduler control run-ready` 只读预览 | TASK-026/028 不再显示 Ready，报告不启动 Task |

## 缺陷记录

- 发现轮次与候选 HEAD：2026-09-30 第一轮；主仓库 `55c6301`（TASK-029 隔离候选尚未集成）。
- 关联原工单、AC、失败用例：TASK-034 AC-2 的 Ready/blocked 准确性；TASK-037 AC-3 的 report-only 指标；本轮 `T037-AC-3`。
- 复现环境与步骤：在主仓库执行 `node dist/cli.js scheduler report . --json` 两次，读取 `.spec-loop/output/ROUND-2026-09-30-scheduler-report-repeat.json`；再以 `node dist/cli.js scheduler control run-ready . --owner round-audit --json` 只读预览。
- 期望结果 / 实际结果：TASK-026 的 v1 `planned` 壳按其规格不得进入 Round，TASK-028 v1 在途且视觉待决，二者都不应标为可派发；实际 report-only 的 13 项中二者 `ready=true`，而受控执行预览 `ready=[]`。第二次报告 canonical hash 稳定，错误可重复。
- 失败 Evidence 与错误指纹：报告 canonical hash `0b0dfb83375ec6894c90b25b3aa76f5d525c4acaa80dc33d54ae1edce573c6c3`；[第一轮矩阵](../05-delivery/2026-09-30-Phase4-完整轮次测试矩阵.md)。指纹 `report-only:v1-resumable-false-ready:TASK-026,TASK-028`。
- 根因、影响范围和严重度：`src/report-scheduler.ts` 将所有 v1 `resumable` 工单直接当成 Ready，未区分可由受控 Scheduler 派发与仅能人工收口的 v1。P1，误导 report-only 质量指标和最终 Heavy 前置，不直接触发自动执行。
- 下一轮修复范围与复测用例：第二轮仅改报告判定与定向测试；与原 5 个未完成工单一同重测完整适用矩阵。若集成候选 HEAD 变化，正式 Gate/V/R 重新绑定。

## 验证范围

- `scope_kind: task`、`coverage: targeted`，只覆盖报告调度器、Task 发现和直接依赖。
- 数据库：`persistent/fixtures`，本工单不使用数据库。
- 人工视觉 Review：不需要。
- Web 功能 Gate：不需要；此工单的输出是 report-only JSON。

## 交付记录

- 完成日期：尚未正式验收；第二轮定向修复与隔离技术复测已进行
- 变更文件/交付物：`src/report-scheduler.ts`、`test/report-scheduler.test.mjs`；隔离修复提交 `5cdcebc`，组合技术候选 `2426a9e`
- 与原设计的差异：无

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-30 | 从第一轮失败用例建立缺陷工单 | 真实项目报告把不可派发的 v1 工单标为 Ready |
