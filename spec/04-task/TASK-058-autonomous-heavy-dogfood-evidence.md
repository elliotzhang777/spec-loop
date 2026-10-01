# TASK-058：Heavy Dogfood 对人工介入历史误报自动闭环

- 状态：已完成
- 风险等级：heavy
- Spec-Loop Task：.spec-loop/tasks/task-058
- Proposal：PROP-26
- 协议版本：P/M/V/R v2
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-10-01
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 来源轮次：第九轮 TASK-037 独立 V，关联 AC-1

## 缺陷

`tools/check-phase4-dogfood.mjs` 仅核查 Candidate、M/V/R 收据和 Gate hash。TASK-029 的同一受管 Run 在第 8、13、17 条历史包含人工 `change_approach` 和等待人工 Review，脚本仍报告 PASS，不能证明“批准后无需循环内人工 Prompt”。独立 V 失败收据在 `.spec-loop/output/TASK-037-acceptance-v2/V/`，原始历史保留。

## 验收标准

- [x] AC-1：Dogfood 审计完整 M→V→R→Candidate 历史，拒绝包含循环内人工动作或人工等待的 Heavy 样本；相关正反用例通过。
- [x] AC-2：一个真实受管 Heavy Task 在批准后由 M、控制器 Gate、独立 V/R 推进到 Candidate，Run 历史无循环内人工 Prompt；与真实 Standard Candidate 一起通过现行 Dogfood 审计。
- [x] AC-3：浏览器 Review Gate 与 Spring T2 的证据完整性缺陷修复，当前 Heavy Task 的 full scope Gate、独立 V/R 通过，并进入 TASK-037 最终完整矩阵。

## 验证计划

本工单本身作为 AC-2 的真实 Heavy 样本：M 提交干净代码候选；full scope Gate 覆盖构建、Dogfood 历史正反用例、真实 Spring T2 与真实浏览器 Review；独立 V/R 后才在 TASK-037 Gate 中选用它。其余两个独立根因见 TASK-059、TASK-060。用户最终 Heavy/Phase 4 决定仍属 TASK-037。

## 最终裁决

Heavy 候选 `bc9138823019da7f5546b86d355732eaf7d0a91e` 自身 4/4 Gate、独立 V/R PASS，受管 Stage 为 Candidate。TASK-037 当前 HEAD `2ebee82eeedfbda1a9645e5b04cecd3632764bef` 的 Dogfood Gate PASS，审计真实 Standard TASK-049 与 Heavy TASK-058 完整历史，旧 TASK-029 人工介入历史被拒绝；Phase 4 完整 Gate 8/8、Node 334/334、独立 V/R PASS。详见 `.spec-loop/output/TASK-058-gates.json`、`.spec-loop/output/TASK-037-phase4-dogfood/report.json` 和两工单受管 Run。
