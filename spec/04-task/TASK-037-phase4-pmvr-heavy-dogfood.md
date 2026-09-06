# TASK-037：Phase 4 P/M/V/R 自动闭环最终 Heavy

- 状态：已批准
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-09-04
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)、[DES-005](../03-design/DES-005-scheduling-worktree-coordination.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)、[FEAT-005](../02-feature/FEAT-005-scheduling-isolation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-026、TASK-029、TASK-031～TASK-036
- 任务等级：Heavy
- 协议版本：P/M/V/R v2
- 所属批次：P4-B4

## 目标

用真实 Standard 与 Heavy Task 证明最新版 P/M/V/R 架构、report-only 到受控执行、角色隔离、失败路由、观察面、Toolchain、Pause/Kill 和飞书本地回退可以形成可恢复闭环，并正式关闭 Phase 4。

## 工作范围

包括 Phase 4 唯一一次 `scope_kind: wave`、`coverage: full` 组合 Gate，真实多 invocation Dogfood、故障/篡改/越权对抗、长期数据库、桌面/窄屏观察面、飞书连接器回退、独立 V/R 和用户 Heavy 验收；不包含自动 merge/push/deploy 或 Phase 5 Portfolio。

## 验收标准

- [ ] AC-1：一个 Standard 和一个 Heavy Task 在批准后无需循环内人工 Prompt 完成 M→V→R→Candidate。
- [ ] AC-2：实现、Evidence、基础设施、规格和高风险失败路由及最多两次语义返工全部真实证明。
- [ ] AC-3：Scheduler report-only 指标达到批准门槛，受控执行的 lease、fencing、资源冲突、Pause/Kill 和恢复通过对抗测试。
- [ ] AC-4：P/M/V/R 观察面、Conflict/Inbox、v1 兼容和旧事实重建准确，桌面/窄屏视觉 Review 通过。
- [ ] AC-5：Spring Boot T2、Playwright、通用 Gate、Evidence hash 和 Candidate Gate 在真实工程通过。
- [ ] AC-6：飞书正式卡片或本地回退完成身份、幂等、断线恢复和人工决定边界验证。
- [ ] AC-7：Phase 1～3 全量回归、Phase 4 安全/隐私/恢复 Gate、独立 V 与独立 R 均 PASS。
- [ ] AC-8：用户对当前 revision 明确完成 Heavy 验收后才允许 Phase 4 Delivery；merge、push、deploy 仍需另行授权。
- [ ] AC-9：Candidate 等待交付期间主分支漂移会被识别为 baseline_drift；显式执行波次时自动回到 M 队列并强制重跑 V/R，旧 Candidate 证据保留且绝不静默复用或自动合并。

## 验证范围

- `scope_kind: wave`，`wave_id: PHASE-4-PMVR`，`coverage: full`。
- 数据库 `persistent`，除专门迁移验证外不得创建或删除容器/数据卷。
- 正式 Gate、V/R、Heavy 人工验收必须在稳定候选形成后重新请求用户明确授权。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 创建并批准 | 为最新版架构建立唯一 Phase 4 全量收口工单，避免每个子 Task 重复全量验证 |
