# TASK-045：Proposal 不得把耗时精度 unknown 当作未填写

- 状态：进行中
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-30
- 最后更新：2026-09-30
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-032（已完成）
- 任务等级：Light
- 协议版本：P/M/V/R v2
- 来源轮次：2026-09-30 第二轮续执行
- 工单类型：缺陷

## 目标

允许有实质内容的 Contract、验收标准和 Proposal 正确描述旧数据的 `unknown` 精度，同时继续拒绝真正未填写的占位值。

## 工作范围

- 修正 `src/files.ts` 的实质内容检查，区分单独占位值与句中的领域术语。
- 加入 TASK-029 Contract 的 v2 Proposal 复现，以及纯占位值仍被拒绝的回归。
- 保留 `TODO`、`TBD`、`待填写`、模板尖括号和双花括号等未完成内容的拒绝边界。
- 不改写 TASK-029 的 AC、Contract 语义或 Gate 门槛。

## 验收标准

- [ ] AC-1：包含耗时精度 `unknown` 的完整 AC/Proposal 可正常创建并保持原文。
- [ ] AC-2：仅含 `unknown` 或 `未知` 的字段，以及显式 TODO/TBD/待填写等占位内容仍被拒绝。
- [ ] AC-3：TASK-029 的原定 Contract 经 P 准备后通过 Proposal 入口，Target Task 文本不需为绕过校验而改写。

## 缺陷记录

- 发现轮次与候选：2026-09-30 第二轮续执行；主分支 `f98fd43`，最终隔离技术候选 `e5ddd81`。
- 关联用例：TASK-029 AC-1 与 P Contract 创建；新增 `T045-AC-1～3`。
- 复现：使用 `.spec-loop/output/TASK-029-contract-draft.json` 调用 `triage propose`，返回 `proposal: empty or placeholder content`；Contract 的 AC-1 和 UC-1 以 `unknown` 描述合法的缺失耗时精度。
- 期望与实际：完整规格文本应被接受，单独占位词才拒绝；实际 `assertSubstantive(JSON.stringify(proposal))` 对 JSON 内任何 `unknown` 命中全局占位正则，无法进入 P。
- 影响：阻断 TASK-029 Heavy 受管 Contract；不能改写 AC 绕过，否则验收语义会漂移。严重度 P1。
- 下一轮验证：定向内容校验/Proposal 测试通过后，纳入整个未完成规格库的完整适用矩阵复测；新的稳定候选重新绑定技术与正式证据。

## 验证范围

- `scope_kind: task`、`coverage: targeted`、`persistent/fixtures`；无视觉或 Web Gate。
- 当前仅有缺陷复现，尚无修复、正式 Gate 或独立 V/R 结论。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-30 | 建立第二轮新缺陷 | TASK-029 Heavy Contract 的合法耗时精度术语被误判为占位内容 |
