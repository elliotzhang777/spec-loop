# TASK-059：Spring T2 Gate 的 PASS 未校验目标工程 HEAD

- 状态：已完成
- 风险等级：standard
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-10-01
- 所属设计：[DES-006](../03-design/DES-006-engineering-toolchain-adapters.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 来源轮次：第九轮 TASK-037 独立 V，关联 AC-5
- 实施归属：TASK-058 Heavy 候选及 TASK-037 最终矩阵

## 缺陷与验收

`tools/check-phase4-spring-t2.mjs` 已计算 `project_unchanged`，但 PASS 条件只检查 Maven 退出码、测试数和工作树状态。若 Maven 运行期间海工工程切换到另一干净 HEAD，仍可能误报 PASS。

- [x] AC-1：PASS 必须要求测试前后目标工程 HEAD 完全一致、工作树干净。
- [x] AC-2：变更 HEAD 的反例不能报告 PASS；真实海工 ArchitectureTest 与 ApiContractTest 仍 2/2 PASS，并纳入最终矩阵。

## 最终裁决

修复进入 TASK-058 Heavy Candidate `bc91388` 及 TASK-037 集成 Candidate `2ebee82`。变更 HEAD 的负例通过，TASK-037 `phase4-spring` 当前 HEAD Gate 退出 0，真实 Maven T2 两条用例 2/2 PASS，目标工程前后 HEAD 一致；后者完整 8/8 Gate、独立 V/R 均 PASS。Evidence 见 `.spec-loop/output/TASK-037-gate-phase4-spring-fa2df8c3-c6b3-48ce-b83a-7a1eb8b1e7dd.txt` 与 `.spec-loop/output/TASK-037-gates.json`。
