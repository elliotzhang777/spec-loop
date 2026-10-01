# TASK-037：Phase 4 P/M/V/R 自动闭环最终 Heavy

- 状态：已完成
- 风险等级：heavy
- Spec-Loop Task：.spec-loop/tasks/task-037
- Proposal：PROP-22
- 协议版本：P/M/V/R v2
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-10-02
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)、[DES-005](../03-design/DES-005-scheduling-worktree-coordination.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)、[FEAT-005](../02-feature/FEAT-005-scheduling-isolation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-029（历史 TASK-031～036 的无效受管依赖已由 Contract v2 修订移除，见 TASK-057）
- 任务等级：Heavy
- 协议版本：P/M/V/R v2
- 所属批次：P4-B4

## 目标

用真实 Standard 与 Heavy Task 证明最新版 P/M/V/R 架构、report-only 到受控执行、角色隔离、失败路由、观察面、Toolchain、Pause/Kill 和本地人工确认可以形成可恢复闭环，并正式关闭 Phase 4。

## 工作范围

包括 Phase 4 唯一一次 `scope_kind: wave`、`coverage: full` 组合 Gate，真实多 invocation Dogfood、故障/篡改/越权对抗、长期数据库、桌面/窄屏观察面、本地 `needs_user`/Review 确认、独立 V/R 和用户 Heavy 验收；不包含飞书连接器实测、自动 merge/push/deploy 或 Phase 5 Portfolio。

## 验收标准

- [x] AC-1：一个 Standard 和一个 Heavy Task 在批准后无需循环内人工 Prompt 完成 M→V→R→Candidate。
- [x] AC-2：实现、Evidence、基础设施、规格和高风险失败路由及最多两次语义返工全部真实证明。
- [x] AC-3：Scheduler report-only 指标达到批准门槛，受控执行的 lease、fencing、资源冲突、Pause/Kill 和恢复通过对抗测试。
- [x] AC-4：P/M/V/R 观察面、Conflict/Inbox、v1 兼容和旧事实重建准确，桌面/窄屏视觉 Review 通过。
- [x] AC-5：Spring Boot T2、Playwright、通用 Gate、Evidence hash 和 Candidate Gate 在真实工程通过。
- [x] AC-6：本地 `needs_user`/Review 确认完成操作者授权、请求幂等、进程重启恢复和人工决定边界验证；不依赖飞书。
- [x] AC-7：Phase 1～3 全量回归、Phase 4 安全/隐私/恢复 Gate、独立 V 与独立 R 均 PASS。
- [x] AC-8：用户对当前 revision 明确完成 Heavy 验收后才允许 Phase 4 Delivery；merge、push、deploy 仍需另行授权。
- [x] AC-9：Candidate 等待交付期间主分支漂移会被识别为 baseline_drift；显式执行波次时自动回到 M 队列并强制重跑 V/R，旧 Candidate 证据保留且绝不静默复用或自动合并。

## 验证范围

- `scope_kind: wave`，`wave_id: PHASE-4-PMVR`，`coverage: full`。
- 数据库 `persistent`，除专门迁移验证外不得创建或删除容器/数据卷。
- AC-3 report-only 量化门槛（按用户 2026-09-30 “不要找我确认”指示由 Codex 代定）：当前 Project 与海工 Project 的重复扫描均 canonical 等价、`missing_data=0`；每个 Ready 必须与同刻受控 `run-ready` 只读预览一致，已知不可派发 v1 的误报数为 0；扫描保持只报告、无 Task 写入或私有内容。没有人工反馈样本时 `adoption_rate=null` 记为 N/A，不伪造采纳率；有反馈样本后必须报告样本量、采纳和误报原值，再单独裁决采纳率。
- 本工单及波次获准启动后，已批准范围、Gate 计划和预算内的正式 Gate、独立 V/R、修复及新 HEAD 复验连续执行；候选变化须重新生成并绑定验证证据，不逐候选重请执行授权。最终 Heavy 人工验收和 Phase 4 阶段验收仍须在稳定候选与完整清单形成后，由用户明确决定。
- 2026-09-28 前置指标事实：海工 report-only 报告 62 项；先前 Ready 3 的工单已推进至 Candidate，最新扫描 Ready 0、阻塞 62、来源缺失 0。尚无人工采纳/误报反馈，采纳率为 `null`。AC-3 所称“批准门槛”尚未量化，不能据这次扫描宣称达到门槛或启动本工单的最终 Heavy Gate。
- 2026-09-30 第一轮失败：当前 Project 的 report-only 稳定扫描把 TASK-026 v1 历史壳、TASK-028 在途 v1 标为 Ready，但受控 `run-ready` 只读预览为空；T037-AC-3 记 FAIL，根因缺陷见 [TASK-044](TASK-044-report-only-v1-false-ready.md)。第二轮修复后须与其余适用用例一同重测；采纳率门槛仍待明确。
- 2026-09-30 最终隔离技术复测：`e5ddd81` 消除上述误报；当前 Project 唯一 Ready 为正在 M 阶段的 v2 TASK-044，海工 v2 Ready 为 WEB-TASK-013，均与受控预览一致；重复扫描 canonical 等价，两个 Project `missing_data=0`，无人工反馈时采纳率仍为 `null`/N/A。受控执行对抗、正式 full Gate/V/R 未完成，仍不能给 AC-3 最终 PASS。
- 2026-09-30 第三轮组合候选 `7f5cacd`：v1 Ready 误报仍已修复，当前 Project 与海工 Project 的报告均与只读受控预览一致，重复扫描 canonical 等价；但当前 Project `missing_data=1`，未达到 AC-3 的 0 门槛。根因是 TASK-045 已批准 Contract 引用未受管的历史 TASK-032，已记入 [TASK-045](TASK-045-proposal-unknown-domain-term.md) 的 Contract 数据待修订项；海工仍为 `missing_data=0`。本工单 AC-3 正式保持 FAIL，其他前置 Heavy 未完成。
- 2026-09-30 用户撤下飞书功能，TASK-026 取消且不再作为本工单前置。AC-6 收敛为本地确认的身份、幂等、重启恢复和人工决定边界；原飞书真实卡片和断线场景不再计入 Phase 4 适用矩阵。其余已批准 AC 和 Heavy 门槛保留。
- 2026-10-01 第七轮报告型门槛复核：当前 Project 与海工 Project 连续扫描 canonical 等价、`missing_data=0`、误报数 0；Ready 分别 0 与 4，均与同刻只读 `run-ready` 预览一致。当前集成 HEAD `c45dea6` 全量 Node 326/326、TASK-029 同范围七项技术重跑均通过；本工单尚无正式 Phase 4 受管 Heavy、Standard/Heavy Dogfood、波次 Review GUI 当前证据与独立 V/R，AC-3/7 等不能据这些局部事实直接记 PASS。用户 Heavy 与阶段决定仍待最终清单裁决，见[第七轮完整矩阵](../05-delivery/2026-10-01-Phase4-第七轮完整测试矩阵.md)。
- 2026-10-01 第八轮前置验证：当前集成 HEAD `c45dea6` 的波次 Review GUI 真实 Chrome 路径通过，覆盖桌面/390px、损坏历史记录隔离、截图 Evidence、统一决定、受控下一轮 M→V→R 和最终候选，报告 `.spec-loop/output/ROUND8-c45-wave-review-browser/report.json` 含 7 张截图哈希。海工真实 Spring Boot Maven 工程 `80f4f0f` 的 ArchitectureTest、ApiContractTest 定向 2/2 PASS；首次无持久库配置的全量 295 项为 1 FAIL、10 ERROR，原因分别为 TimesheetTest 空 JdbcTemplate 与缺少 `TASK047_MYSQL_URL`，原始日志及报告见 `.spec-loop/output/ROUND8-offshore-spring-t2.json`。这两个项目工程事实不得冒充本工单正式受管 Heavy 或全量 PASS；AC-5/7 仍待真实 Gate、环境恢复和独立 V/R。
- 2026-10-01 第九轮最终技术裁决：候选 HEAD `2ebee82eeedfbda1a9645e5b04cecd3632764bef` 的受控 Heavy Gate 8/8、Node 334/334、Playwright 2/2、真实 Standard/Heavy Dogfood、Spring T2 2/2、Scheduler/安全稳定性测试均 PASS；当前 Project 与海工各两次 report-only canonical 等价、`missing_data=0`，Ready 与只读预览一致。当前 revision 的 `REVIEW-1` 视觉记录、独立 V/R 均 PASS，受管 Stage 为 Candidate。第一次 R 对实时扫描与视觉证据缺口的 FAIL，以及两次 Playwright 配置/环境拒绝均保留，最终修复见 TASK-061、TASK-062。证据入口为 `.spec-loop/output/TASK-037-gates.json`、`.spec-loop/tasks/task-037/reviews/REVIEW-1.md`、`.spec-loop/tasks/task-037/ACCEPTANCE_RUN.json`。AC-8 的用户最终 Heavy/Phase 4 决定仍待当前候选完整清单，不得据技术 Candidate 提前 Delivery。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 创建并批准 | 为最新版架构建立唯一 Phase 4 全量收口工单，避免每个子 Task 重复全量验证 |
| 2026-09-28 | 对齐波次连续执行授权 | 清理候选变化后重复请求正式 V/R 授权的旧表述，保留最终 Heavy/阶段人工决定 |
| 2026-09-30 | 撤销飞书前置并收敛 AC-6 | 用户明确不需要飞书功能；Phase 4 只验证本地人工确认路径 |

## 2026-10-02 最终验收

用户明确接受当前 Candidate 的最终 Heavy 与 Phase 4 阶段验收；当前 HEAD、计划 hash、受管 Gate、独立 V/R 与视觉 Review 均已对账。决定与边界见[最终人工验收记录](../05-delivery/2026-10-02-Phase4-最终人工验收记录.md)。本工单 AC 全部通过、状态关闭；受管 Run 保留 Candidate 历史阶段，merge、push、deploy 未执行。
