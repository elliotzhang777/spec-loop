# TASK-032：P/M/V/R 隔离角色编排

- 状态：待验证
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-09-06
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-031
- 任务等级：Standard
- 协议版本：P/M/V/R v2
- 所属批次：P4-B2

## 目标

让确定性 Controller 能按批准契约调度物理隔离的 M、V、R invocation，并把权限、输入、输出、失败分类和重试边界固化为运行事实。

## 工作范围

### 包含

- P/M/V/R invocation manifest、最小上下文包、权限和输出目录；
- M 可写候选、V/R 只读候选及各自 Evidence 写区的强制边界；
- Provider Adapter 的启动、取消、超时、退出和恢复；
- V/R invocation 身份独立性、结果 Schema 和失败路由；
- 共享语义返工预算、基础设施重试和重复指纹熔断接入真实调度；
- Candidate Gate 前的 HEAD、Plan 与 Evidence 新鲜度复核。

### 不包含

- 多 Task 并发、跨机器 Worker、自动发布；
- report-only Scheduler；
- 生产系统或 Connector 写权限。

## P/M/V/R 职责

- P：提供已批准且不可降级的契约。
- M：唯一可修改候选，提交稳定新 HEAD 和自测 Evidence。
- V：使用新 invocation 执行计划，只写 V Evidence。
- R：仅在 V PASS 后以另一 invocation 复核，不重跑 V 测试。

## 验收标准

- [ ] AC-1：M、V、R 使用不同 invocation manifest；M 可写候选，V/R 对候选只读且写区互斥。
- [ ] AC-2：Controller 只从批准 Contract 和稳定 HEAD 编译计划，不能接受角色自由文本降低或替换 AC。
- [ ] AC-3：Provider 中断、超时或进程崩溃后可 reconcile，未知结果不得被投影为 PASS。
- [ ] AC-4：V/R 所有分类按架构路由，语义返工、基础设施重试与失败指纹预算正确生效。
- [ ] AC-5：只有当前 V PASS、当前 R PASS 和未篡改 Evidence 才生成 Candidate。
- [ ] AC-6：任何角色都不能触发 merge、push、deploy、凭据、生产数据或未批准外部副作用。
- [ ] AC-7：Provider 可执行文件、参数与版本在 prepare/run 间保持同一身份；usage 缺失显式记为未记录，相同确定性工具失败达到阈值后熔断，M 不得提交正式 Task 规格。
- [ ] AC-8：真实 Codex 使用同参数、UTF-8、sandbox 和 Evidence 写区 runtime probe；角色运行中按流式 Token/费用预算终止完整进程树。
- [ ] AC-9：成功 M 自动提交并编译；V/R 只自动摄入合法 `RESULT.json`，缺失或无效结果明确进入 `awaiting_ingestion`/`invalid`。

## 验证计划

使用临时 Git/worktree、伪 Provider、权限故障、崩溃恢复和篡改 Fixture 进行 targeted Gate；正式 V/R 需绑定稳定候选。

## 验证范围

- `scope_kind: task`，`coverage: targeted`，数据库 `persistent/fixtures`。

## 实现与快速反馈记录

- 新增受管 M/V/R invocation manifest、固定上下文 hash、互斥 Evidence 根目录和 Provider 生命周期命令。
- M 使用候选 worktree；V/R 使用稳定 HEAD 导出的独立只读快照，任何快照或源候选变化均 fail closed。
- M 必须在本次 invocation 内产生新的非 merge HEAD 并在独立 Evidence 根写入自测证据；无新提交、脏工作区或合并提交均拒绝推进。
- 新默认 v2 Run 强制成功受管 invocation；遗留显式 v2（项目仍默认 v1）保持 TASK-030 兼容路径。
- 超时、取消、进程消失 reconcile、未受管结果、重复 M invocation 和 V/R 身份复用均拒绝推进。
- Provider 身份在 prepare/run 两处绑定；每次 invocation 保存输入、缓存输入、输出、推理、总 Token 与费用字段，项目/Task 可汇总，Provider 未返回时保持“未记录”。
- 相同 Adapter/工具失败指纹连续达到契约阈值后停止再次启动；M 新提交若包含已批准 `target_spec`，invocation 失败关闭。
- 2026-09-04 快速反馈：编译通过；新增角色对抗用例 1/1，通过既有 acceptance-loop 分类/预算/Candidate 用例。尚未执行正式独立 V/R。

## 变更记录

- 2026-09-06：V/R 的只读 `git archive` 快照不包含 `.git`；Codex Adapter 对这两个角色显式加入 `--skip-git-repo-check`，避免把可信目录检查误判为实现失败。
- 2026-09-06：真实 V 发现纯 `read-only` sandbox 也阻止 Evidence 输出，且相对 Evidence/Context 路径诱发无界目录搜索。V/R 改为“物理只读候选 + 指纹复核 + 仅 Evidence 根可写”，通过 `workspace-write --add-dir EVIDENCE_ROOT` 建立最小写边界；Prompt 使用绝对控制路径、禁止全库递归摄入，并明确确定性 Gate 由 Controller 执行。
- 2026-09-06：结构化 V/R 输入中的相对 Evidence 路径统一相对 Project 根解析；绝对路径仍受 Project 根、常规文件和非符号链接约束，并新增 V/R 相对路径端到端回归。
- 2026-09-06：新增真实 Codex 20 秒 runtime probe、UTF-8 受控环境、Project 共享 npm/Maven cache、流式 Token/费用熔断、完整进程组终止和结构化结果自动摄入。

## 2026-09-06 专项正式验证记录

- 隔离 TASK-043 的 M、V、R 使用三个不同受管 invocation；V/R 使用不可变候选快照和独立 Evidence 根，Controller Gate、Contract、Plan、HEAD 与 Evidence hash 完整绑定。
- V 与 R 均 PASS并生成 Candidate；真实 Codex V 的超时尝试没有被投影为 PASS，而是在 180 秒波次熔断后进入 cancelled。
- 本记录覆盖 Adapter 启动参数、快照信任、Evidence 写边界、角色心跳和当前 Evidence 绑定；外部 Codex 的 locale/model-manager 超时仍属于 Provider/运行环境风险，不能写成引擎已修复。
- TASK-032 其他 AC 仍保留在验证看板，未执行 Delivery、merge、push 或 deploy。

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 创建并批准 | 将最新版架构中的角色物理隔离从状态机内核拆成真实运行编排 |
| 2026-09-04 | 实现候选进入待验证 | 受管 invocation、快照隔离、生命周期恢复和强制绑定完成 |
| 2026-09-06 | 故障加固 | 增加 Provider 身份、usage 汇总、重复失败熔断、输出上限和正式 Task 写保护 |
