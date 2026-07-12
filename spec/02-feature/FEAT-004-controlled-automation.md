# FEAT-004：批准后的受控自动闭环

- 状态：草稿
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 所属阶段：Phase 4

## 用户价值

作为任务提交者，我希望批准 Proposal 后，系统能自动计划、开发、验证、迭代和验收，只在歧义、高风险或熔断时找我。

## 行为说明

确定性 Controller 编排 Spec Analyst、Planner、Plan Reviewer、Maker、Gate Runner、独立 Checker 和 Acceptance Judge。Scheduling 在进入自动执行前先长期 report-only。

## 业务规则

1. Approval 绑定 Proposal/Spec hash、范围、风险、批准人、时间和有效期。
2. Agent 不得修改 Spec/AC 或直接迁移状态。
3. Maker 与 Checker 是独立 invocation；Heavy 额外人工检查。
4. retry 必须有新 Evidence、不同动作或明确修复目标。
5. 失败分类为 repair、replan、provider retry 或 needs_user。
6. Guard 在新 Round 前自动执行。

## 验收标准

- AC-1：report-only Scheduling 的误报、采纳和成本可观察。
- AC-2：Standard 与 Heavy 从一次批准后自动闭环，无循环内人工 Prompt。
- AC-3：所有自动转换可以从结构化结果和 Evidence 重算。
- AC-4：Maker/Checker 强制分离，Heavy 人工检查有效。
- AC-5：未批准、内容已变化或过期 Approval 不能执行。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-004 受控自动 Controller](../03-design/DES-004-controlled-automation-controller.md) | 草稿 |
| Task | 待 Phase 4 进入条件满足 | 草稿 |

## 实际交付

- 已实现行为：无。
- 验证结论：待验证。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 加入 Approval 与自动 Controller | 最终 Roadmap 定稿 | - |

