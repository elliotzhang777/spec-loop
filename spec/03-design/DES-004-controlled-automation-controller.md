# DES-004：受控自动单任务 Controller

- 状态：草稿
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)

## 设计目标

在用户批准后自动推进一个任务的计划、实现、验证、迭代和 Acceptance，替代循环内重复 Prompt。

## 现状与约束

- 现状：Phase 3 目标是手工生命周期 + Codex 单步执行。
- 技术约束：依赖稳定 Harness、worktree、T1 Gate、Project approval。
- 不在范围：Portfolio 和系统自动修改核心 Policy。

## 方案概览

```text
Approved Proposal/Task
→ Spec Analyst → Planner → Plan Reviewer
→ Maker → Deterministic Gates → Independent Checker
→ Acceptance Judge → Controller decision
→ complete | repair | replan | provider-retry | needs_user
```

## 详细设计

- 每个角色使用版本化 Prompt、严格输入输出 Schema 和独立 invocation。
- Maker 只能执行当前 approved step。
- Gate 的机械事实优先于模型意见。
- Judge 只能引用当前 Evidence ID，不能凭代码观感通过 AC。
- Controller 是唯一自动状态迁移者，迁移语义等价于现有 CLI。
- Approval hash/risk/scope/expiry 每轮检查。
- Guard 控制新 Round；无新信息 retry 被拒绝。

## 方案取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 确定性 Controller + 多角色 | 可审计、可拒绝 | 成本较高 | 采用 |
| 单 Agent 自循环 | 简单 | 自证和偏航 | 拒绝 |

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| Reviewer Theater | 错误交付 | Gate + 独立上下文 + Heavy 人工 | 退回 Phase 3 手工推进 |
| 自动错误分类 | 错误 retry | 结构化证据和熔断 | needs_user |

## 验证策略

Standard/Heavy fixture 和真实低风险任务从一次批准后闭环；人工追加 Prompt 为 0；失败分类、状态和 Evidence 可重算。

## 工单拆分

Phase 4 未满足进入条件，不创建工单。

## 实际实现

- 最终实现：未开始。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 加入 Approval 驱动和自动角色链 | 最终 Roadmap | - |

