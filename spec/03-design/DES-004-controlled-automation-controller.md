# DES-004：受控自动单任务 Controller

- 状态：进行中
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-08-31
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)

## 设计目标

在用户批准验收契约后，以确定性状态机推进 M 实现、V 独立验收、R 独立复核和人工冲突处理，替代循环内重复 Prompt，同时保证 v1 在途任务可无损继续。

## 现状与约束

- 现状：Phase 3 已有 Approval、Worktree、稳定 HEAD、Collect、Gate 和 Evidence hash，但 `verify` 同时承担验收与最终结论，V/R 尚未分离。
- 技术约束：依赖稳定 Harness、worktree、T1 Gate、Project approval。
- 不在范围：Portfolio 和系统自动修改核心 Policy。

## 方案概览

```text
P: Spec + Task + Acceptance Contract → Human approval
                                  ↓
M: implement + self-test → stable HEAD
                                  ↓
Controller: compile(contract, HEAD, diff, toolchain, environment)
                                  ↓
V: independent acceptance → pass | implementation | infrastructure | spec/high-risk
                                  ↓ pass only
R: independent evidence review → Candidate | M | V | human
                                  ↓ budget exhausted / conflict
                    waiting_human_review + Conflict Record
```

## 详细设计

### 协议版本和兼容

- v1 `TASK_STATE.md/VERIFY.md` 生命周期保持原样；已经开始的 Task 不自动写入 v2 工件。
- v2 是显式 opt-in，权威运行态写入 `ACCEPTANCE_RUN.json`，不反向改写 v1 状态枚举。
- 同一 Task 创建 v2 Run 后固定 `protocol_version: 2`；不允许运行中降级或隐式迁移。

### P：验收契约

- `ACCEPTANCE_CONTRACT_V2.md` 包含 contract version、Task、AC、use cases、tools、assertions、evidence requirements、risk、critical path、依赖和 human approval。
- `contract_hash` 对去除 approval 签名字段后的规范化内容计算；approval 再绑定 contract hash、批准人和时间。
- 修改契约必须提升 version、重新批准并创建新的 Run；旧 Evidence 不可继承为新契约的 PASS。

### M：稳定候选

- M 是唯一拥有候选 Worktree 写权限的角色；提交时绑定当前 Git HEAD、Collect 中的 worktree fingerprint 和自测 Evidence。
- 首次提交后进入执行计划编译；实现问题返工回 M，并消耗一次共享语义返工预算。
- M 返工提交的 HEAD 必须不同于上一次 M 提交，否则拒绝推进。

### 执行计划编译

- 输入固定为 contract hash、HEAD、base、diff hash、worktree fingerprint、项目 Gate 定义、lockfile/toolchain hash 和环境指纹。
- 输出逐 AC 映射 use case、tool、command、assertion 和 required evidence；允许补充更强检查，不允许删除 AC 或弱化 assertion/evidence。
- 计划计算 `plan_hash`；V/R 所有结果都绑定该 hash 和 HEAD。

### V：独立验收

- V 使用独立 invocation，候选目录只读，只允许写 `V/` Evidence 区域。
- Spec-Loop 运行确定性 Gate 并保存原始 artifact/hash；V 的结构化结论只能引用本 Run 当前 HEAD 的 Evidence。
- `implementation_problem` 回 M；`infrastructure_problem` 使用单独有界重试；`spec_ambiguity` 或 `high_risk` 立即转人工。

### R：独立复核

- 只有 V PASS 才能进入 R；R 只读候选和 V Evidence，不能修改代码，也不能代替 V 执行测试。
- `implementation_problem` 回 M；`evidence_problem` 回 V；`spec_problem` 转人工；PASS 后执行证据完整性门禁并生成 Candidate。
- R PASS 必须覆盖全部 AC、引用当前 V evidence set hash，并与 V invocation 不同。

### 预算、指纹与冲突

- `semantic_reworks_used` 在 R/V 路由回 M 或 R 路由回 V 时增加，最大为 2；初次 M/V/R 不计返工。
- `infrastructure_retries` 按阶段单独计数且有界，避免偶发环境故障吞掉实现返工预算。
- failure fingerprint 由 stage、classification、failed AC、稳定化 message 和相关 artifact hash 组成；相同指纹重复达到阈值可提前转人工。
- 人工冲突的权威事实是不可变 Conflict Record；`REVIEW_INBOX.json` 只从 active Conflict 重建。

### 调度与人工动作

- 普通、非关键路径 Task 在 `waiting_human_review` 时可暂挂；其下游依赖保持 blocked，其他 Ready Task 继续。
- Heavy、高风险或关键路径冲突立即标记 `requires_immediate_attention`。
- 人工动作包括 `revise_spec_and_reauthorize`、`change_approach`、`split_task`、`waive_noncritical`、`mark_external_block`、`cancel`。
- 非关键豁免产生新契约版本并重新 V/R；安全、隐私、权限、数据完整性和关键路径 AC 不允许豁免。

## 方案取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 确定性 Controller + 多角色 | 可审计、可拒绝 | 成本较高 | 采用 |
| 单 Agent 自循环 | 简单 | 自证和偏航 | 拒绝 |

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| Reviewer Theater | 错误交付 | V/R 不同 invocation、R 只引用当前 Evidence | 退回 v1 手工推进 |
| 自动错误分类 | 错误 retry | 枚举分类、失败指纹和人工熔断 | waiting_human_review |
| 升级破坏在途任务 | v1 Task 停止或状态损坏 | 双轨协议、显式 opt-in、不重启现有 dist 服务 | 删除 v2 Run 工件，v1 继续 |
| 环境抖动耗尽返工 | 无效人工升级 | 基础设施重试预算与语义预算分离 | 转外部阻塞 |

## 验证策略

覆盖状态合法性、HEAD/证据新鲜度、计划完整性、V/R 隔离、全部失败路由、共享预算、基础设施预算、重复指纹熔断、Conflict/Inbox 重建、依赖阻塞和 v1 兼容。当前工单只运行定向构建与相关测试，不对正在执行的 TASK-027/028 做迁移或正式验收。

## 工单拆分

[TASK-030](../04-task/TASK-030-pmvr-acceptance-loop.md) 实现 v2 旁路协议、执行计划、V/R 结果、预算和人工冲突；默认协议切换另行授权。

## 实际实现

- 最终实现：进行中。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 加入 Approval 驱动和自动角色链 | 最终 Roadmap | - |
| 2026-08-31 | 将 Checker/Judge 明确拆分为 V/R，并新增共享返工预算、Conflict Record 与 v1 双轨兼容 | 用户确认的新验收治理流程 | TASK-030 |
