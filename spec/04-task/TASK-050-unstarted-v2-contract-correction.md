# TASK-050：M 提交前无法审计修订已批准 v2 Contract

- 状态：已完成
- 风险等级：standard
- Spec-Loop Task：.spec-loop/tasks/task-050
- Proposal：PROP-18
- 协议版本：P/M/V/R v2
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-30
- 最后更新：2026-09-30
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 来源轮次：第五轮 TASK-045 Contract 数据修订阻塞
- 工单类型：协议恢复缺口

## 问题与证据

TASK-045 的 P Contract 已批准，Run 处于 `m_working`，M 尚未提交任何 HEAD。批准时把已完成但未受管的历史 TASK-032 写入 `depends_on`，使 M 提交前置检查阻断、report-only `missing_data=1`。现有 `approveAcceptanceContract` 在 Run 存在后拒绝修订，`acceptance resolve` 又要求活动 Conflict；M 前置检查直接抛错，不会产生 Conflict。因此合法的版本 2 修订草案无法通过受管入口写入。草案仅提高版本并删除错误依赖，其他 AC、工具、预算和断言逐字段不变；见 TASK-045 的草案哈希和 `.spec-loop/tasks/task-045/ACCEPTANCE_RUN.json`。

## 工作范围

- 增加仅在尚未提交 M HEAD、且没有活动 M 调用时可用的 P Contract 数据修订入口；必须有人批准新 Contract 精确 hash、写明理由、保存旧版本和 Run 历史。
- 对 TASK、风险、AC、Use Case、工具、断言、Evidence 要求和预算保持逐字段相同；该入口只允许提高版本并校正 `depends_on`，不允许借此变更实施或验收范围。
- 一旦已有 M 提交、V/R 计划或 Candidate，必须拒绝此入口，仍通过现有 Conflict/Review 路径处理。
- 用 TASK-045 的实际版本 2 草案完成受管修订，消除 report-only 缺失数据，并继续其 M/V/R。

## 验收标准

- [x] AC-1：M 未提交的 v2 Run 可由批准人和理由校正依赖数据，新版本 hash、旧版本归档、Run 历史和审计记录一致。
- [x] AC-2：范围、验收标准、工具、预算变化及活动 M 调用或已提交候选均被拒绝，失败不得部分写入。
- [x] AC-3：TASK-045 原批准内容保留，版本 2 依赖修订后恢复 M/V/R，当前 Project 报告型扫描 missing_data 降至 0。

## 验证范围

定向 Contract 修订及恢复测试、TASK-045 真实受管路径；最终完整回归纳入 Phase 4 Heavy。

## 收口证据

候选 `b25019b1ed26b2a2581daf67b7358972cd8119de` 的受管 build 与 acceptance-loop 41/41 Gate、独立 V/R 均 PASS。TASK-045 实际 Contract 已受管修订至版本 2，仅删除错误历史依赖，审计和旧版归档见 `.spec-loop/output/TASK-045-contract-correction-applied.json`；修订后报告型扫描 `missing_data=0`，见 `.spec-loop/output/TASK-050-post-correction-report.json`。TASK-045 的后续 M/V/R 由该工单自身收口，不作为本工单候选状态的替代。
