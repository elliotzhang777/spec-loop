# TASK-061：Phase 4 Playwright Gate 缺少验收声明

- 状态：已完成
- 风险等级：standard
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-10-01
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 关联受管工单：TASK-037
- 来源轮次：第九轮 TASK-037 受控 V

## 缺陷

TASK-037 的 P 批准 v2 Contract 已要求 `phase4-e2e` Playwright Gate，当前 `.spec-loop/GATES.md` 也配置了该 Gate，但从 Proposal 创建的 v1 Task 壳 `ACCEPTANCE.md` 中 `web_gates` 仍为空。Controller 在全量执行前拒绝 V：`phase4-e2e: Playwright Gate is not declared as required in ACCEPTANCE.md`。失败调用为 `INV-TASK-037-V-71280d89-cc07-4307-a17f-34f8c0460f41`，首次导入结果见 `.spec-loop/output/ROUND9-TASK037-V2-CONTROLLED-INGEST.json`。这不是测试失败，不能记作全量 PASS。

## 验收标准

- [x] AC-1：仅将 P 已批准的 `phase4-e2e` 及 AC-4/AC-5 加入未开始 Round 的 v1 Task 壳，保留原计划、原状态和修改前后 hash 审计。
- [x] AC-2：`ACCEPTANCE.md`、`PLAN.md`、`TASK_STATE.md` 与 `STATE_HISTORY.jsonl` 的验收 hash 和状态版本一致，控制面可读取。
- [x] AC-3：TASK-037 当前 HEAD 的受控 V 实际运行批准的 Playwright Gate，取得截图 Evidence，与其他七组 Gate 一起通过。

## 修复与证据

已用 `.spec-loop/output/ROUND9-TASK037-REPAIR-DECLARATION.mjs` 在未开始 Round 且 v2 批准工具存在的前提下执行一次性绑定修复；前后 hash、状态版本和原因见 `.spec-loop/output/ROUND9-TASK037-REPAIR-DECLARATION.json`。修复后 `acceptance status` 可读。AC-3 以当前轮受控 Gate 结果裁决。

最终 TASK-037 当前 HEAD `2ebee82` 的 `phase4-e2e` 受控 Playwright Gate 退出 0，2/2 浏览器用例、2 张截图、完整 8/8 Gate 和独立 V/R 均 PASS；Gate Evidence 见 `.spec-loop/output/TASK-037-gates.json`。这项缺陷为批准内容在未启动的 v1 控制壳中的声明遗漏，修复未扩张 v2 批准 Contract。

最终 `spec-loop check` 发现两次未开 Round 的声明补录在 v1 状态历史中形成非法 `planned→planned` 转移。原状态和历史已原样归档，按已批准声明重放合法的 `draft→planned→working` 壳历史；审计见 `.spec-loop/output/ROUND9-TASK037-STATE-REPLAY-AUDIT.json`，补录前两份 hash 审计仍保留。重放后 `spec-loop check`、`review status` 与 v2 Candidate 状态均通过。
