# TASK-057：Phase 4 Contract 引用没有受管记录的历史依赖

- 状态：已完成
- 风险等级：standard
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-10-01
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 关联受管工单：TASK-037
- 来源轮次：第九轮真实 Project report-only 扫描

## 缺陷

TASK-037 初版批准 Contract 的 `depends_on` 包含 TASK-031～036，但它们是历史规格工单，没有对应 v2 受管记录。当前 Project 重复扫描虽然 canonical 等价，`missing_data=1`，TASK-037 被标记为 `unknown v2 contract dependency`，不满足 AC-3 的零缺失门槛。初次扫描保留在 `.spec-loop/output/ROUND9-root-report-1.json` 和 `ROUND9-root-report-2.json`。

## 验收标准

- [x] AC-1：在 M 候选提交前，用批准的依赖修订通道归档初版 Contract，仅删除无效的 TASK-031～036 依赖；AC、工具、证据要求和预算不变。
- [x] AC-2：Task 的 Contract 与 Run 均绑定 v2 修订，初版及授权人、原因保留审计记录。
- [x] AC-3：当前 Project 重复 report-only 扫描 canonical 等价且 `missing_data=0`；TASK-037 可继续正式 M/V/R。

## 交付与证据

取消未提交候选的 M 调用后，通过 `acceptance revise-unstarted-dependencies` 将 TASK-037 Contract 升至 v2，保留唯一有效受管前置 TASK-029。归档与审计在 `.spec-loop/output/TASK-037-acceptance-v2/CONTRACT-v1-856b831f7c8d2ac08e498d80db9f6dc4999c58f47ce6b98b73a28e64d6272394.md` 和 `.spec-loop/output/TASK-037-acceptance-v2/CONTRACT-REVISION-v2-22986e415e16947e5f592b236c6bfef09df24a8b2fce18bdff553a61415702d8.json`。修订后两次报告 `.spec-loop/output/ROUND9-root-report-after-revision-1.json`、`ROUND9-root-report-after-revision-2.json` 均为 `missing_data=0`、canonical hash 相同。此单修复的是批准 Contract 数据，不改产品依赖门禁。
