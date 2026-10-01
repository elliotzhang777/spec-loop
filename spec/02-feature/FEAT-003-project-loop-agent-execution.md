# FEAT-003：Project Loop 与 Agent 受控执行

- 状态：已完成
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-08-03
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 所属阶段：Phase 3

## 用户价值

作为用户，我希望在一个工程中管理多个任务、手动发现候选工作，并让 Codex 在隔离环境完成明确批准的步骤，从而从单任务文件升级为可运行的 Project Loop。

## 行为说明

Project metadata 和 Project State 提供项目上下文；Task Registry 从任务目录重建；Triage 只产生 Proposal；批准后创建正式 Task。Codex Harness 在 worktree 执行 `prepare → execute → collect → verify → report`。Phase 3 多任务可管理但默认串行。

## 业务规则

1. Registry 是可重建索引，不得覆盖 Task State。
2. Project State 原生保存目标、候选、忽略原因和下一步；活跃/阻塞/Delivery 从 Task 派生。
3. 未批准 Proposal 不能成为 Task；批准绑定 Proposal/Spec hash、范围和风险。
4. 初始 Provider 为 Codex、Claude Code、Qoder，默认 Codex；真实 Dogfood 首先要求 Codex。
5. 真实代码修改必须使用独立 worktree/branch，禁止 push/merge。
6. T1 Gate 生成绑定真实 HEAD 的 Evidence。
7. Phase 3 不做 Scheduling、并发 Worker 或自动 Round Controller。
8. 每个 Project 的目标仓库必须维护独立 `spec/` 规格库；初始化不得覆盖已有规格文件，缺失结构必须能补建和校验；正式 Task 必须同步生成目标工程 Task 规格，或在显式操作且内容一致时接管已批准的草稿规格。
9. Controller 必须区分快速反馈检查、候选版本检查和正式交付 Gate；低风险反馈默认只运行受影响检查。Task/Loop 启动、“继续执行”和效果修改不构成正式交付授权；只有用户对当前稳定候选明确要求进入正式验证/交付后，才统一执行一次完整 Harness。候选变化后授权失效，验证范围和升级原因必须记录。
10. UI 或视觉 AC 必须声明人工视觉 Review；批准绑定当前 Round、revision 和截图哈希，被拒绝、截图变化或 revision 变化后不得验证通过。
11. 阶段验收和进入下一阶段必须单独获得用户确认，不能从 Task 启动授权、历史授权或单个 Task Delivery 推导。
12. 非 Heavy Task 只能执行定向验证并复用长期验证数据库；全量覆盖和一次性数据库只允许有明确范围与原因的 Heavy Task。

## 验收标准

- AC-1：按状态、项目和 resumable 查询多个任务。
- AC-2：Registry 可删除重建且不产生第二套状态。
- AC-3：Triage Proposal 未批准时不能创建 Task。
- AC-4：Codex 在 worktree 完成真实任务并生成 HEAD Evidence。
- AC-5：Delivery 生成 Project 回写摘要但不写外部系统。
- AC-6：两个真实项目 Dogfood delivered，独立 Verifier PASS。
- AC-7：Project 初始化会建立目标工程规格库，`project spec-check` 对缺失或空文件严格失败。
- AC-8：同一 Task 的低风险反馈不会机械重跑历史 Task Gate；正式 Delivery 仍保留完整验证且 Evidence 绑定最终 HEAD。
- AC-9：视觉 Review 可请求、批准或拒绝，且未批准或失效的 Review 会阻断 Verification 与 Delivery。
- AC-10：Project 可把后端主规格库、前端卫星规格库或二者直接初始化到源码仓，并将 `TASK-*`/`WEB-TASK-*` 路由到对应规格目录。
- AC-11：未获得当前候选的显式正式验证授权时，Controller 停留在 feedback；效果拒绝或候选变化后不得自动重跑完整 Harness。
- AC-12：引擎拒绝非 Heavy 全量验证、非 Heavy 一次性数据库和 persistent Gate 的容器创建/删除。

## 非功能要求

- 安全：Provider 不直接修改控制文件；无 push/merge/Connector write。
- 可恢复：Project/Registry/Harness 中断后可 reconcile。
- 可观测：记录 Provider、worktree、base/HEAD、命令和 artifact。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-003 Project Control Plane 与 Agent Harness](../03-design/DES-003-project-loop-agent-harness.md) | 已完成 |
| Task | [TASK-003 Phase 3 Heavy 主工单](../04-task/TASK-003-phase3-project-loop.md)、TASK-004～TASK-012、[TASK-013](../04-task/TASK-013-phase3-hardening-acceptance.md)、[TASK-016](../04-task/TASK-016-define-verification-scope.md)、[TASK-017](../04-task/TASK-017.md)、[TASK-018](../04-task/TASK-018.md)、[TASK-019](../04-task/TASK-019.md)、[TASK-020](../04-task/TASK-020.md) | 全部完成 |

## 实际交付

- 已实现行为：Project/Registry/Triage/Approval、由随包版本清单驱动的目标工程规格库、Provider config、worktree、T1 Gate、Codex Harness 和 write-back。
- 未实现/调整项：多任务仍串行；Claude Code/Qoder 未做真实 Dogfood；Phase 3 由 Controller 人工选择反馈检查范围，自动影响分析和 Gate Planner 留给 Phase 4 Toolchain。
- 新增能力：Task Acceptance 可声明 `REVIEW-*` 视觉卡点；CLI 保存截图副本、哈希、Round、revision 和人工决定，当前批准失效时 Verification 与 Delivery fail closed。
- 新增能力：目标规格模板 v4 支持 `backend`、`frontend`、`fullstack`，规格和 Task 随对应源码进入同一个 Git 候选；旧 `standard` 项目保持兼容；已发布 v1～v4 使用摘要锁定，禁止原地漂移。
- 新增能力：Gate Plan 显式绑定 `targeted/full` 与 `persistent/disposable`，普通 Task 无法再误跑整轮回归或反复重建数据库容器。
- 验证结论：最终候选 `3b05ac59a5d14b21486362ab4179f053eedc6ffb` 的 WPHASE3 全量 Harness Gate 与 67 项测试全部通过；独立 Verifier 结论为 PASS，用户已完成 Heavy 人工确认并重新签署正式 Delivery。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 融合 Project Loop 与执行基础 | 最终 Roadmap 定稿 | - |
| 2026-07-15 | 增加反馈检查与正式 Gate 分层 | 避免低风险改动重复运行完整交付闭环 | TASK-016 |
| 2026-07-19 | 统一目标规格模板事实源 | 自托管检查发现内联模板漂移、缺少 Architecture 和检查规则误报 | TASK-017 |
| 2026-07-19 | 收敛工程根目录并按 Phase 归档历史验证现场 | 让当前实现、运行产物和历史 Evidence 的边界可直接辨认 | TASK-018 |
| 2026-07-23 | 增加绑定候选版本的人工视觉 Review | 避免用笼统 human_checked 或 Agent 自评替代效果验收 | TASK-019 |
| 2026-07-24 | 吸收分工程规格模板并增加源码仓配置 | 让后端主规格和前端 Web 工单与各自实现共同版本化 | TASK-020 |
| 2026-07-25 | 增加正式验证显式授权边界 | 避免把 Loop 启动或视觉迭代误判为正式交付 | TASK-016 |
| 2026-07-26 | 强制定向 Gate 与长期数据库复用 | 降低普通 Task 验证耗时和环境反复创建成本 | TASK-016 |
| 2026-08-03 | 完成 Phase 3 正式 Heavy 验收 | 加固版本的完整 Gate、独立 Verifier 和人工确认全部通过 | TASK-013 |
| 2026-09-30 | 记录 Phase 4 回归的测试并发缺陷 | 受管 `WEXEC-VIEW` 的 321 项在高负载下有 6 个时限用例误失败；历史 Phase 3 Delivery 不改写 | [TASK-046](../04-task/TASK-046-quality-suite-concurrency-stability.md) |
| 2026-09-30 | 关闭测试并发缺陷 | `9e95565` targeted Gate 2/2、独立 V/R PASS，形成 Candidate；完整 Heavy 7/7 保留在 tree 相同的 `7f5cacd`，新集成候选由 TASK-029 复测 | [TASK-046](../04-task/TASK-046-quality-suite-concurrency-stability.md) |
| 2026-09-30 | 记录第四轮快速退出测试竞态 | 新集成 `36c631a` 全量质量 320/321、六个其他 Heavy Gate PASS；固定 300ms 身份探测用例 `not ok 216`，转 TASK-047 以真实 exit 事件同步 | [TASK-047](../04-task/TASK-047-fast-exit-identity-test-race.md) |
| 2026-10-01 | 收口快速退出测试竞态 | `70688bb` 定向 Gate 2/2、独立 V/R PASS；集成 `246cecd` 七组 Heavy Gate、Node 322/322 PASS | [TASK-047](../04-task/TASK-047-fast-exit-identity-test-race.md) |
| 2026-10-01 | 收口 v1 报告型调度夹具 | TASK-053 在 `8df95df` 定向 Gate 2/2、独立 V/R PASS；同 tree 集成 `c45dea6` 全量质量 326/326，原 325/326 失败保留 | [TASK-053](../04-task/TASK-053-v1-report-fixture-round-placeholder.md) |

## 2026-10-01 第九轮技术验收同步

TASK-056 历史 Gate Evidence 不可覆写、TASK-059 Spring HEAD 绑定均完成，TASK-037 最终集成 8/8、Node 334/334、独立 V/R PASS；Phase 4 最终用户决定待办。见[第九轮完整矩阵](../05-delivery/2026-10-01-Phase4-第九轮完整测试矩阵.md)。
