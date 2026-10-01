# TASK-054：已批准但未绑定的目标工单无法导入受管控制面

- 状态：已完成
- 风险等级：standard
- Spec-Loop Task：.spec-loop/tasks/task-054
- Proposal：PROP-23
- 协议版本：P/M/V/R v2
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-10-01
- 最后更新：2026-10-01
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 来源轮次：第八轮，TASK-037 正式 P onboarding
- 关联工单：TASK-037 AC-1、AC-7
- 来源候选：集成 `c45dea66cd8a707b3c36d48b9a2980d340001650`；当前主分支 `a236afc43fbc9c190882c8ba3e29aeb7e4787fbd`

## 缺陷与复现

正式规格库中的 TASK-037 已由用户批准，9 条 AC 与 P Proposal `PROP-22` 的批准 Contract 完全一致，且此前未绑定 Spec-Loop 控制 Task。`PROP-22` 获 `APR-24` 后运行 `triage create-task . PROP-22 --id TASK-037 --title 'Phase 4 P/M/V/R 自动闭环最终 Heavy' --adopt-existing` 返回 `only a draft target task may be adopted`。根因是 `src/project.ts` 的 `adoptTargetTask` 只允许目标文件状态为草稿，无法把已有的已批准未绑定工单纳入受管 P/M/V/R。原始 CLI 失败和 Proposal/批准记录在 `.spec-loop/proposals/PROP-22.json`、`.spec-loop/approvals/APR-24.json`；第八轮交付记录保留命令与退出码。

期望：在目标工单 ID、标题、逐项 AC 与已批准 Proposal 精确相同、没有既有绑定时，允许导入状态为“已批准”的工单并保留其状态和历史；其他不匹配、重复绑定或未批准 Proposal 仍 fail closed。实际：即使全部权威事实一致也被状态限制拒绝，TASK-037 正式 Heavy 无法启动。复现命令、退出码和权威文件哈希见 `.spec-loop/output/ROUND8-TASK037-onboarding-failure.json`。

## 验收标准

- [x] AC-1：批准的 P Proposal 可导入精确匹配的已批准且未绑定目标工单；导入后目标状态仍为已批准，受管 Contract/Proposal 绑定完整。
- [x] AC-2：草稿导入仍可用；ID、标题、AC、既有绑定、非批准状态或未批准 P 的错误仍明确拒绝，不降低原有门禁。
- [x] AC-3：定向 Project/onboarding Gate、独立 V/R 和下一轮完整适用矩阵通过；TASK-037 能据此建立受管 Task。

## 验证计划

使用 `coverage: targeted` 验证 `src/project.ts` 与 `test/project.test.mjs` 的批准态导入和拒绝路径；受管 v2 Candidate 另行绑定当前 HEAD，下一轮 Heavy 复核集成回归。无视觉范围。

## 交付记录

- 当前状态：已由 `PROP-23`/`APR-25` 受管导入；隔离修复 `cfaa01e` 的 `npm run build` 及 `test/project.test.mjs` 10/10 PASS，后续 `1716e2e` 补强重复/非批准状态拒绝，定向用例 1/1 PASS。修复 CLI 已将 TASK-037 的已批准原规格成功导入且保留状态，正式 M/V/R 与下一轮完整矩阵仍待完成。
- 设计差异：仅扩展已批准且未绑定、ID/标题/AC 精确匹配的目标状态；既有 Proposal 批准、重复绑定和不匹配门禁保持。
- 最终裁决：候选 `98d51cfaa2419837a1218852cda1475d7bc43e77` 的受控定向 Gate 2/2 PASS；新的独立 V/R 均 PASS，受管 Stage 为 Candidate。修复已纳入 TASK-037 集成候选 `2ebee82eeedfbda1a9645e5b04cecd3632764bef`，其完整 Heavy Gate 8/8、Node 334/334、独立 V/R PASS；此前 R 的完整矩阵证据缺口已由当前 V/R 正式复核。原始证据见 `.spec-loop/output/TASK-054-gates.json`、`.spec-loop/output/TASK-037-gates.json`、`.spec-loop/tasks/task-054/ACCEPTANCE_RUN.json`。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-10-01 | 建立缺陷工单 | TASK-037 已批准规格无法通过受管 onboarding |
