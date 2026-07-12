# FEAT-007：Portfolio、能力资产与持续优化

- 状态：草稿
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 所属阶段：Phase 5

## 用户价值

作为多个 Project Loop 的管理者，我希望统一查看项目组合、获得可解释排序建议、复用经过评测的能力，并在人工治理下持续优化。

## 行为说明

Portfolio 是从项目事实重建的只读索引；能力资产记录版本、来源、权限、适用范围、Eval、兼容和回滚；优化只能生成 Proposal，经独立 Eval、人工批准、灰度和观察后推广或回滚。

## 业务规则

1. Portfolio 不成为 Project/Task 状态事实源。
2. 排序建议必须解释数据、权重和依赖，用户可覆盖。
3. 能力资产不能携带项目私有数据。
4. 指标说明来源、窗口、缺失值和可比性。
5. 核心协议、安全策略、Denylist 和 Connector 权限不能自动修改。
6. 凭据、Memory、History 和 Connector 按项目隔离。

## 验收标准

- AC-1：Portfolio 可删除后从 Project/Task 事实重建。
- AC-2：跨项目建议可解释、可覆盖、可审计。
- AC-3：资产具备版本、hash、owner、权限、Eval、兼容和回滚。
- AC-4：优化严格经过 Proposal→Eval→Approval→灰度→观察→推广/回滚。
- AC-5：跨项目数据与凭据隔离通过架构、安全和隐私审查。
- AC-6：长期数据证明自动化收益。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-007 Portfolio 与能力治理](../03-design/DES-007-portfolio-capability-governance.md) | 草稿 |
| Task | 待 Phase 5 进入条件满足 | 草稿 |

## 实际交付

- 已实现行为：无。
- 验证结论：待验证。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 替换原有限自治方向 | 最终 Roadmap 定稿 | - |

