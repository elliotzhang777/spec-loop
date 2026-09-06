# TASK-035：Scheduler Lease、资源协调与 Pause/Kill

- 状态：待验证
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-09-06
- 所属设计：[DES-005](../03-design/DES-005-scheduling-worktree-coordination.md)
- 所属特性：[FEAT-005](../02-feature/FEAT-005-scheduling-isolation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-034 达到 report-only 稳定门槛
- 任务等级：Standard
- 协议版本：P/M/V/R v2
- 所属批次：P4-B3

## 目标

为已批准 v2 Task 提供 Project/task lease、fencing token、资源声明、Pause/Kill 和恢复，使无冲突 Ready Task 可受控执行而冲突写入保持串行。

## 工作范围

包括 lease/fencing、repo/branch/module/tool resource claim、Ready/blocked 队列、Pause/Kill/reconcile、幂等键、预算和 Denylist；不包含跨机器 Worker、生产发布或默认 Connector 写权限。

## 验收标准

- [ ] AC-1：同一 Project/Task 不会被两个有效 lease 同时写入，过期 Worker 的结果被 fencing token 拒绝。
- [ ] AC-2：冲突资源严格串行，无冲突任务只在批准范围和预算内并发。
- [ ] AC-3：Pause 不启动新动作；Kill 取消运行、保留现场并要求 reconcile 后才能恢复。
- [ ] AC-4：崩溃、时钟漂移、PID 复用、重复回调和陈旧结果均不能形成虚假 PASS 或 Candidate。
- [ ] AC-5：Denylist 阻止 merge、push、deploy、凭据、生产数据和未批准外部副作用。
- [ ] AC-6：关键路径、高风险和下游阻塞符合最新版架构的人工升级规则。
- [ ] AC-7：Task 停止先落审计事件，再取消角色、Run 与 lease，保存实际 Worktree HEAD，回收死亡 Driver 锁；重复停止不追加第二个取消事件。
- [ ] AC-8：只读维护盘点能定位 worktree、node_modules、Maven cache 和大文件，只把 delivered/cancelled worktree 列为退休候选，绝不自动删除。
- [ ] AC-9：显式 `run-ready --execute` 在同一波次并发启动无冲突 Ready Task，并由波次时间、Token、费用预算熔断；usage 缺失时 fail closed。
- [ ] AC-10：事务 journal 在并发 Worker 间互斥，任何 Worker 都不能恢复或删除另一个尚未完成的事务。
- [ ] AC-11：Worktree 退役默认只预览；只有终态、干净、无活动 Effect/lease 且显式 HEAD 相符时才移除目录，并保留 branch、manifest 和退役记录用于恢复。
- [ ] AC-12：运行中的角色和 Effect 持续写独立心跳；健康检查能识别死亡 PID、陈旧心跳、死亡 Driver 与过期波次；独立常驻 Supervisor 以单实例、可核验 PID 身份和自身心跳持续执行受超时隔离的 watchdog，并自动停止不健康 Task。
- [ ] AC-13：Git、Candidate snapshot 和工具控制面子进程均有确定超时，不能无限等待文件系统、hook 或管道关闭。
- [ ] AC-14：Dashboard 提供角色心跳、deadline、熔断剩余时间、实时 Token 与结果摄入状态；Snapshot 不超过 256 KiB。
- [ ] AC-15：Supervisor 提供不自动安装的 launchd 恢复计划；Evidence 可持久归档，依赖下载使用 Project 共享 cache，并保留显式、可审核的退休策略。

## P/M/V/R 职责与验证范围

P 定义资源和安全断言；M 实现；V 运行并发/故障注入；R 复核时序与 Evidence。使用 `scope_kind: task`、`coverage: targeted`、`persistent/fixtures`。

## 实现与快速反馈记录

- 新增 Project/Task lease、owner nonce、单调 fencing token、idempotency key 和 repo/branch/module/tool resource claim。
- 相同 Task 和冲突资源严格串行；无冲突资源可在同一 Project lease 内并行。
- Task lease 可按 fencing token 正常释放；Project lease 仅在其所有活动 Task lease 已释放后才允许释放。
- Pause 阻止新 lease；Kill 取消运行 invocation、fence 活动 lease、保留现场并强制 reconcile 后恢复。
- 过期/陈旧 token、重复键不同事实、角色不匹配结果均拒绝；merge/push/deploy/credential/production/external action 默认 deny。
- 新增原子化 `stop-task` 闭环：取消事件、角色与活动 Effect 终止、实际 HEAD、v1/v2 取消、lease fencing、Driver 停止请求/死亡锁回收和幂等 marker 绑定为同一结果。
- 新增只读产物盘点；它不跟随符号链接、不删除历史数据，并给出终态 worktree 的显式退休候选和保留风险。
- 新增真正的波次 Ready 调度：M、V、R 合法阶段按独立 branch 资源并发，成功 invocation 必须等待显式结果摄入，不会自动 merge/push/deploy。
- 新增波次预算记录与 wall-clock/Token/cost 熔断；Provider 不返回完整 usage 或 cost 时停止继续派发并显示未记录。
- 修复原子事务恢复的并发竞态；为同一 Project 根目录的 journal 增加互斥和死亡 owner 回收。
- 新增显式 Worktree 退役命令，要求 expected HEAD，并验证终态、clean、branch 可恢复以及无活动 Effect/lease。
- 新增角色/Effect 两秒心跳、只读 `health` 和显式 `watchdog --apply`；死亡/陈旧 owner 会进入可审计停止闭环。
- 新增独立常驻 Scheduler Supervisor；每次 watchdog 在独立子进程中执行并受硬超时和输出上限保护，Supervisor 本身通过 PID 启动时间、单实例锁和心跳接受健康检查，可幂等启动/停止。
- `run-ready --execute` 会先确保该 Project 的独立 Supervisor 已健康运行，并把 Supervisor PID 身份写入波次记录；无法建立健康监督时拒绝派发业务角色。
- 修复仓库布局 Gate：架构图归档到 `spec/03-design/`，并将承担构建期契约检查的 `tools/` 明确列为当前工程职责。
- 为 Git、Candidate snapshot 与维护控制命令增加 30～60 秒硬超时，避免非 Provider 子进程无限等待。
- Dashboard Snapshot 收紧为每 Task 最近 20 个步骤和 256 KiB 硬上限；实时角色状态携带心跳、deadline、剩余时间、usage 与摄入状态。
- 新增只读 retention plan、幂等 Evidence archive、Project 共享 npm/Maven cache 和可审核但不自动安装的 macOS launchd 模板。
- 2026-09-04 快速反馈：编译通过；`test/scheduler-control.test.mjs` 1/1 通过。尚未执行正式独立 V/R。

## 2026-09-06 专项正式验证记录

- 在隔离工程 `/tmp/spec-loop-formal.U7hNFU/control` 创建并批准 TASK-043，候选 HEAD `fa56a3960bf637faf42a497c909add166c9d8afb`。
- M 自测、Controller Gate 与独立 V/R 均绑定同一 HEAD；Supervisor 回归 3/3、启动与仓库布局回归 4/4，V 与 R 均 PASS，生成 Candidate `CANDIDATE-TASK-043-1788679012336`。
- 真实 Codex V 曾在 180 秒波次预算处触发熔断；Task 被原子取消、实际 HEAD 被保留、计时停止，Supervisor 继续健康运行。这一事实验证了防卡死关闭路径，但不等于外部 Codex Provider 本身已恢复稳定。
- 本记录只覆盖 AC-12、AC-13 及其直接依赖的停止/波次边界；TASK-035 其余 AC 仍保持“待验证”，不据此宣称整个工单交付。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 创建并批准 | 将自动执行前必需的隔离、停止和恢复边界独立验收 |
| 2026-09-04 | 实现候选进入待验证 | lease、fencing、资源协调、Pause/Kill/reconcile 和 denylist 完成 |
| 2026-09-06 | 故障加固 | 增加 Task 停止闭环、取消竞态 HEAD 对账、Driver 锁回收与只读产物盘点 |
| 2026-09-06 | 专项正式 V/R | 独立 Supervisor、波次绑定、熔断和有界子进程在同一候选 HEAD 上通过 |
