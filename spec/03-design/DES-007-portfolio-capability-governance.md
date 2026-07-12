# DES-007：Portfolio、能力资产与优化治理

- 状态：草稿
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属特性：[FEAT-007](../02-feature/FEAT-007-portfolio-capability-optimization.md)

## 设计目标

从多个可靠 Project Loop 聚合只读 Portfolio，管理可复用能力资产，并以可评测、可批准、可灰度、可回滚方式持续优化。

## 现状与约束

- 现状：尚无多个长期运行的 Project Loop。
- 技术约束：只有 Phase 4 长期稳定且有真实数据后才能实施。
- 不在范围：Portfolio 写 Task State、跨项目共享 Secret、自动修改核心 Policy。

## 方案概览

```text
Project/Task/Run Facts → Rebuildable Portfolio → Explainable Ranking
                                     ↓
Versioned Capability Registry → Eval → Approval → Canary → Observe → Promote/Rollback
```

## 详细设计

### Portfolio

只读聚合 project/task/progress/blocker/risk/budget/dependency/conflict/delivery/automation。删除后从事实重建。

### 排序建议

输入用户优先级、依赖、风险、成本、收益、截止时间和资源冲突；输出每个因素、权重和解释；用户覆盖形成事件。

### 能力资产

资产类型包括 Protocol、Skill、Triage、Verifier、Eval、Harness/Toolchain Adapter、Connector、模板、安全策略。元数据包含 version、content hash、owner、source、scope、required permissions、evaluation、compatibility、rollback、replacement。

### 指标质量

记录来源、窗口、分母、缺失值、估算/实测和可比性。项目敏感数据在聚合前脱敏或排除。

### 优化治理

历史事实只产生 Proposal；独立 Eval 后人工批准；灰度绑定项目范围和期限；指标恶化自动建议回滚，但不自动改核心协议、安全 Policy、Denylist 或 Connector 权限。

### 隔离

Portfolio 不包含 Credential；Memory/History/Connector 按项目隔离；能力包发布前扫描私有数据和权限声明。

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| 指标不可比 | 错误排序 | provenance/window/comparability | 禁用跨项目比较 |
| 能力资产泄漏私有信息 | 隐私事故 | package scan + project isolation | 下架版本、轮换凭据 |
| 自我优化扩大权限 | 安全漂移 | Proposal + human gate | 回滚资产/Policy 版本 |

## 验证策略

删除重建 Portfolio、解释/覆盖排序、资产升级/回滚、跨项目数据污染对抗、架构/安全/隐私独立审查。

## 工单拆分

Phase 5 未满足进入条件，不创建工单。

## 实际实现

- 最终实现：未开始。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 建立 Portfolio 与能力治理设计 | 最终 Roadmap | - |

