# FEAT-005：Scheduling、隔离与安全控制

- 状态：已批准
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-09-27
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 所属阶段：Phase 4

## 用户价值

作为多任务用户，我希望系统能定时发现工作、隔离自动修改、检测资源冲突并随时暂停，同时不越过 Connector 和生产权限边界。

## 行为说明

初期 Scheduler 只报告；批准后任务在 worktree 中受控执行。Project/task lease、fencing token、resource claim、预算、Denylist、Pause/Kill 和审计共同约束自动化。

## 业务规则

1. report-only 稳定前不得自动创建或执行 Task。
2. 所有自动代码修改必须使用 worktree、branch、base commit 和 touched files 记录。
3. 无冲突任务可并发，冲突写资源必须串行。
4. Pause 阻止新动作；Kill 取消执行、保留现场并要求 reconcile。
5. Connector 按只读→评论/标签→有限状态更新逐级授权；首个双向实现为 [FEAT-008 飞书正式机器人](FEAT-008-feishu-progress-approval-connector.md)，远程决定仍必须经过本地 Guard。
6. 默认禁止 merge、删除、生产数据、凭据和发布动作。
7. 已批准 Task 内的 M/V/R 及范围内修复连续执行；执行授权绑定各 Task 范围/预算，验证证据绑定 HEAD/计划 hash。候选变化必须重验，但不重复询问继续验证；普通确认汇总到规格库轮次裁决。
8. 新范围、权限、Gate 计划或预算变化必须先处理授权；不可逆、生产或无法隔离的安全风险只暂停受影响范围。
9. 用户级轮次覆盖完整规格库的全部未完成 Task 及其批准的全部测试用例；已批准且具备条件的 Task 按依赖推进并在稳定候选上逐用例集中测试、V/R 和裁决。待人工确认或外部条件的 Task 记录阻塞，让独立 Task 继续；确认的代码失败按根因建立缺陷 Task，下一轮与原未完成 Task 一起修复并重测完整适用矩阵。既有 `wave` 阶段屏障和 Review Bundle 仅作为内部实现，不把波次边界变成用户级验收停点；已有 V/R 状态或返工记录的执行沿用原协议和预算，不中途迁移。

## 验收标准

- AC-1：Scheduler report-only 试运行可衡量。
- AC-2：所有自动代码修改隔离且可清理/恢复。
- AC-3：冲突检测、Lease 和 fencing 阻止双写。
- AC-4：Pause/Kill 立即阻止后续动作并保留证据。
- AC-5：Connector 最小权限和 Denylist 对抗测试通过。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-005 Scheduling、Worktree 与资源协调](../03-design/DES-005-scheduling-worktree-coordination.md) | 已批准 |
| Task | [TASK-034 Report-only Scheduler](../04-task/TASK-034-report-only-scheduler.md) | 已完成 |
| Task | [TASK-035 Lease、资源协调与 Pause/Kill](../04-task/TASK-035-scheduler-leases-controls.md) | 已完成 |
| Task | [TASK-037 Phase 4 最终 Heavy](../04-task/TASK-037-phase4-pmvr-heavy-dogfood.md) | 已批准 |
| Task | [TASK-044 Report-only v1 Ready 误报缺陷](../04-task/TASK-044-report-only-v1-false-ready.md) | 进行中，第二轮技术复测通过 |

## 实际交付

- 已实现行为：Ready/blocked、Conflict/Inbox、真实 Scheduler Lease、资源 fencing、Pause/Kill、预算和独立 Supervisor 已形成实现候选。2026-09-26 补齐范围内连续 M/V/R、失败返工、新 HEAD 复验、普通待决任务让路、波次末统一验收清单与本地审批界面，并可在同一次决定中批准、启动下一波。
- 验收边界：接受候选重新核对 HEAD、计划、证据和必要视觉/Heavy 决定；暂缓 Task 保留现场，下一波只执行明确退回或继续的范围。新候选作废旧 PASS，但原范围内执行不重复申请授权。
- 2026-09-26 继续加固：噪声输出不冒充进展；启动探针继承取消与预算；后台授权死亡、有界清单收尾失败、停止凭据中断均能保留事实并恢复；慢看板保留存活身份，历史读取复用校验结果。
- 2026-09-27 复查修复：执行恢复绑定具体波次/租约代际，用量分批合并正确，数字噪声不延长进展；事件历史分段并保留全链与未结束步骤；未验收旧波次持续可达，损坏记录单独报告，提交后列表同步。
- 验证结论：实现与定向检查记录在 TASK-035 和交付审计中；TASK-035 仍为待验证，未将测试夹具的 V/R 结果当作真实业务工单的正式验收，也未启动 Phase 4 最终 Heavy 交付。
- 2026-09-29 TASK-034 在固定候选 `cbc1a5d` 上独立 V/R 均 PASS，report-only 的可衡量、只报告和损坏输入保护已完成；TASK-035 的 report-only 稳定前置条件满足。FEAT-005 其余 Lease/波次能力仍待各自验证，不据此关闭整个 Feature。
- 同一候选的 TASK-035 独立 V/R 对 17 条 AC 全部 PASS，Chromium 功能与截图哈希已绑定；人工视觉 Review 仍待用户决定，Phase 4 Heavy 与真实业务角色未运行，Feature 继续保持当前状态。
- 用户于 2026-09-29 批准 TASK-035 当前候选的人工视觉效果，决定记录绑定 HEAD 和 7 张截图哈希；TASK-035 已关闭。FEAT-005 仍需最终 Heavy/阶段验收，不因子工单完成自动关闭。
- 2026-09-30 用户将后续推进节奏改为完整规格库轮次：全部未完成 Task 同轮盘点、可执行项按依赖推进、冻结候选后集中验证和裁决。TASK-035 的既有 Wave 实现与历史验收事实保持不变，用户级清单跨 Wave 汇总，原生跨规格库自动编排尚未实现。
- 2026-09-30 第一轮真实 report-only 扫描发现 TASK-026 v1 历史壳和 TASK-028 在途 v1 被标为 Ready，受控执行预览却无 Ready Task。该误报不改写 TASK-034 的历史 PASS，已建 TASK-044 在第二轮修复并完整复测；TASK-037 AC-3 暂记 FAIL。
- 2026-09-30 第二轮隔离组合候选 `49612eb`：报告调度器 4/4 与完整质量套件 320/320 技术通过；当前 Project TASK-026/028 非 Ready、海工合法 v2 Ready 保留。正式 Contract/Gate/V/R 和 TASK-037 指标门槛尚未完成，不把技术自测写成最终 Feature PASS。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 融合 Scheduling、多任务和安全控制 | 最终 Roadmap 定稿 | - |
| 2026-08-04 | 将飞书正式机器人下沉为独立 Feature | 通用 Connector 规则不足以表达远程身份、卡片确认和恢复契约 | TASK-021～026 |
| 2026-09-04 | 批准 report-only 与受控执行两段实施 | 先证明报告质量，再开放 lease 约束下的自动动作 | TASK-034、TASK-035、TASK-037 |
| 2026-09-30 | 将用户级推进改为完整规格库轮次 | 避免逐 Task、逐波次请求决定和反复重绑候选证据 | TASK-026、028、029、033、037 |
