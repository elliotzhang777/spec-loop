# DES-004：受控自动单任务 Controller

- 状态：进行中
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-09-04
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

### Provider 运行门禁与在线预算

- 真实 Codex 在语义身份变化后执行最长 20 秒的同参数 runtime probe，验证 UTF-8 locale、sandbox、Evidence 写区和最小响应；成功缓存 1 小时，确定性失败缓存 5 分钟，避免长期复用过期环境结论。
- invocation 心跳携带角色阶段、deadline、剩余时间、最新 usage、角色预算和最后真实进展。stdout/stderr 或 usage 长期无变化时，即使 Controller 心跳仍正常也按无进展熔断；达到 Token/费用上限时先 TERM、后 KILL 完整进程树，并用 PID 启动身份验证退出对象。
- M/V/R 可分别绑定已启用的 Provider；全局切换会同步三个角色映射，避免默认 Provider 与角色配置互相冲突。
- M 成功后自动收集受管 Evidence、提交候选并编译计划；V/R 只在独立 Evidence 根提供合法 `RESULT.json` 时自动摄入。无结果使用 `awaiting_ingestion`，无效结果使用 `invalid`，均不得投影成运行中或 PASS。
- 相对 Evidence 路径以 Project 根为基准，仍要求常规非符号链接文件且 realpath 不得逃逸。

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

| 工单 | 交付物 | 依赖 | 状态 |
|---|---|---|---|
| [TASK-030](../04-task/TASK-030-pmvr-acceptance-loop.md) | v2 旁路协议、执行计划、V/R 结果、预算和人工冲突 | TASK-013、019 | 已完成 |
| [TASK-031](../04-task/TASK-031-v2-contract-onboarding.md) | P 契约同步生成、新任务默认 v2 与模板接入 | TASK-030 | 已完成 |
| [TASK-032](../04-task/TASK-032-pmvr-role-orchestration.md) | M/V/R 真实 invocation 隔离与 Controller 调度 | TASK-031 | 已完成 |
| [TASK-039](../04-task/TASK-039-target-task-filename-resolution.md) | 精确/带名称目标 Task 规格解析与歧义拒绝 | TASK-031 | 已完成 |
| [TASK-040](../04-task/TASK-040-m-worktree-git-admin-sandbox.md) | M linked-worktree Git 管理根最小授权与 V/R 隔离 | TASK-032 | 已完成 |
| [TASK-041](../04-task/TASK-041-candidate-quality-portable-files.md) | 公开示例配置与 CRLF 候选质量兼容 | TASK-032、040 | 已完成 |
| [TASK-042](../04-task/TASK-042-v2-controlled-v-harness-freeze.md) | v2 Controlled V 自动冻结干净候选与 collect 证据 | TASK-030、032 | 已完成 |
| [TASK-043](../04-task/TASK-043-approved-repository-bash-gates.md) | P 契约与 Run 精确绑定的仓库 Bash Gate | TASK-030、042 | 已完成 |
| [TASK-037](../04-task/TASK-037-phase4-pmvr-heavy-dogfood.md) | Phase 4 唯一全量 P/M/V/R Heavy Dogfood | TASK-026、029、031～036 | 已批准 |

## 实际实现

- 实际实现：TASK-030/031 在候选 `af57702` 重新通过独立 V/R。v2 批准以项目目录外的本机私有密钥签署，doctor/status 校验 Contract 与 Run hash；TASK-032 的真实隔离角色编排在 `af57702` 重新通过独立 V/R，包含 Provider 准备/诊断与运行阶段的进程沙箱及真实 Codex 探针。
- 已完成：TASK-039 在 `eca847d` 独立 V/R PASS；`triage create-task --adopt-existing` 按精确或唯一带名称规格原位采用，同 ID 多候选 fail closed，海工 live 目录仅保留一份 TASK-001。
- 已完成：TASK-040 在 `eca847d` 独立 V/R PASS；M 仅附加真实 worktree/admin 与 common Git 根，参数去重并拒绝越界/符号链接，V/R 仍只给独立 Evidence 根。
- 已完成：TASK-041 在 `eca847d` 独立 V/R PASS；精确放行三种 `.env` 示例、允许纯 CRLF，真实环境/私钥文件与尾随空格保持 fail closed。
- 已完成：TASK-042 在 `eca847d` 独立 V/R PASS；缺失旧 Harness state 可自动产生 HEAD/base/status/diff/content 指纹及 collect hash，脏树和不匹配候选 fail closed。
- 已完成：TASK-043 在 `4366ed8` 独立 V/R PASS；`bash scripts/check.sh` 必须精确匹配经完整性校验且与当前 Run 相符的 P 契约，脚本不可越界/链接，实际运行固定 `/bin/bash` 和受控 PATH。完整 Phase 4 Heavy 尚未执行。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 加入 Approval 驱动和自动角色链 | 最终 Roadmap | - |
| 2026-08-31 | 将 Checker/Judge 明确拆分为 V/R，并新增共享返工预算、Conflict Record 与 v1 双轨兼容 | 用户确认的新验收治理流程 | TASK-030 |
| 2026-09-04 | 将目标架构拆为内核、接入、真实角色编排和最终 Heavy | 避免一个工单同时承担协议、运行时和阶段验收 | TASK-030～032、037 |
| 2026-09-29 | 目标 Task 文件名解析完成定向验收 | TASK-039 独立 V/R PASS，保持目标规格单一权威与真实路径绑定 | TASK-039 |
| 2026-09-29 | M Git 管理根最小授权完成定向验收 | TASK-040 独立 V/R PASS；不扩大到仓库父目录或 V/R 候选写权限 | TASK-040 |
| 2026-09-29 | 候选质量兼容完成定向验收 | TASK-041 独立 V/R PASS，保留敏感文件和真实空白错误拒绝 | TASK-041 |
| 2026-09-29 | Controlled V 自动冻结完成定向验收 | TASK-042 独立 V/R PASS，同候选幂等且不跳过 Gate 前后指纹校验 | TASK-042 |
| 2026-09-29 | 仓库 Bash Gate 完成定向验收 | TASK-043 独立 V/R PASS；契约完整性、Run 绑定及 PATH 假解释器复现均封闭 | TASK-043 |
