# DES-005：Scheduling、Worktree 与资源协调

- 状态：已批准
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-09-30
- 所属特性：[FEAT-005](../02-feature/FEAT-005-scheduling-isolation.md)

## 设计目标

在 report-only 试运行后安全调度批准任务，保证代码、项目运行、工具资源和 Connector 权限不会冲突或越界。

## 现状与约束

- 现状：Phase 3 已完成多任务管理、串行单步 Harness、worktree 隔离和正式 Heavy 验收；当前没有 Scheduler。
- 技术约束：依赖单步 worktree 和 Phase 4 Controller 幂等。
- 不在范围：跨机器分布式 Worker 和默认生产写入。

## 方案概览

```text
Scheduler(report-only) → Proposal Report → Approval
                                      ↓
Project Run Lease → Task Queue → Resource Claims → Worktree Worker
                                      ↓
Budget / Denylist / Pause / Kill / Connector Policy
```

## 详细设计

### 调度

保存 run ID、scan cursor、idempotency key 和项目 lease。report-only 阶段不创建 Task、不改代码。

### 资源协调

task lease 包含 owner、expiry、fencing token；resource claim 覆盖 repo path、branch/module、Simulator、DerivedData、工具实例。无冲突并发，冲突写串行。

### Pause/Kill

Pause 阻止新 Triage/Task/Round，允许安全 Gate 收尾。Kill 取消 Agent/命令，将操作标记 interrupted/unknown，保留 worktree/证据，reconcile 后才恢复。

### 连接器

按项目授权，只读开始；评论/标签和有限状态更新单独批准。merge、delete、生产数据、credential、签名和发布默认 deny。飞书正式机器人的进度投影、远程身份、交互确认、Inbox/Outbox 与恢复契约由 [DES-008](DES-008-feishu-bot-connector.md) 定义。

### 安全与审计

单任务/全局 Budget、path/action denylist、高风险人工 gate、所有 Policy decision 和外部副作用审计。

### 规格库轮次编排（2026-09-30 起）

- 用户级轮次从全部 `spec/04-task/` 状态生成，不从单个 Scheduler Wave 推断范围。清单列出每个未完成 Task 的状态、依赖、批准范围、可执行工作、外部阻塞和必要人工决定；`pending-board` 保存完整盘点，`verification-board` 保存待验证 Evidence。
- 同一轮先按依赖完成具备条件的实现、必要定向反馈与候选集成；被阻塞 Task 留在清单中，不使其他 Task 停工。依赖所需的内部状态和核验照原 Task 协议执行，但不逐 Task/逐 Wave 向用户请求推进决定。
- 进入集中验证前冻结可审计候选 HEAD 和适用的 Task worktree HEAD。先从每个未完成 Task 的 AC、验证计划、已批准 Contract/Gate、Web 路径、人工 Review 和跨 Task 回归生成完整用例矩阵，逐项标出适用性、前置条件、执行入口、预期与证据位置；新增或变化的批准用例必须同步矩阵。各 Light/Standard Task 运行批准的 targeted Gate；各 Heavy Task 按其批准计划运行必要的 full Gate，重合范围不重复。矩阵中每项均给出绑定当前候选的 PASS、FAIL、BLOCKED 或 NOT_APPLICABLE；V PASS 后才可 R；视觉、Heavy 和阶段决定集中呈现，但仍分别绑定适用 HEAD、计划 hash 和截图。
- 集中测试先覆盖全部可执行用例并记录失败，不在每个失败后切换回零散实现。失败归因后按根因创建缺陷 Task，保留失败用例到缺陷工单的映射；环境不可用、规格冲突和人工待决单独记录。集中裁决列出完成、失败、缺陷工单、外部阻塞和暂缓的全部 Task；下一轮把原未完成 Task 与新缺陷 Task 一同推进，再冻结新候选并重测完整矩阵及新增用例。裁决不能把未测试、未批准或被阻塞的 Task 标成 PASS，也不自动扩大预算或外部权限。
- 现有 `wave`、Lease、Review Bundle、`run-approved` 和 Gate `scope_kind` 不改变协议或存储格式；它们可承载一轮内的多个内部执行片段，但当前没有跨规格库的一键轮次控制器。当前轮次由规格清单和现有受控入口编排，不能把本规则描述为已实现的自动化能力。

### 既有波次末人工验收（内部控制面）

- 执行授权与验收证据分离：已批准 Task/波次的范围、权限、Gate 计划和预算覆盖 V 失败后的 M 修复、自测、新 HEAD 的 V/R 复验；仅作废旧 HEAD 的证据和验收决定，不撤销执行授权。不得再以“新候选须批准继续 V/R”打断同一范围的工作。用户明确暂停、范围/权限/计划/预算变化或无法隔离风险时例外。
- Gate 是自动验证机制，不等同于人工确认。已经进入批准波次的 Task 在既定规格、权限、资源和预算范围内连续执行 P/M/V/R 与 Gate，不因每个阶段或每个 PASS 单独打断用户。
- 需要人工接受的普通事项统一延迟到波次结束。波次进入 `awaiting_wave_review` 后生成单一 Wave Review Bundle，汇总每个 Task 的最终 HEAD、Candidate、AC 覆盖、Gate/V/R、截图、偏差、失败、耗时、Token、费用和推荐动作。
- 用户可在一次审阅中批准整个波次、只批准部分 Task、退回指定 Task，或结束波次但暂不合并。所有决定仍绑定 Project、Task、Round、HEAD、计划 hash、操作者、过期时间和单次消费键；事实变化后旧决定自动失效。
- 执行中遇到普通 `needs_user` 时，只将受影响 Task 置为 `awaiting_wave_review`，保存 HEAD 与 Evidence，释放 Worker/Lease，并继续调度不依赖它的任务；不得让一个确认点阻塞整个波次。
- 只有破坏性或不可逆操作、新增外部权限/凭据/生产副作用、预算或时限越界、无法在现有隔离内控制的安全风险、以及 HEAD/权威状态无法对账时允许即时暂停。暂停应尽量限定在受影响 Task 或资源域，而不是停止整个波次。
- 既有 Wave Review Bundle 可同时承载下一波计划授权；2026-09-30 起这只是内部受控入口，不再作为默认用户级推进停点。不得借此绕过 Heavy 人工验收、视觉验收或其他必须在合并/交付前完成的政策。

2026-09-26 实现候选：`run-ready --execute` 曾按单任务 Ready 状态连续调度 M → Controlled V → 独立 R；V 的实现类失败在单任务返工预算内回 M。此为旧流程，运行中或已进入 V/R/返工的任务不迁移。

2026-09-28 波次流程：新启动、全部 Task 均处于首次 `m_working` 的波次，按 `implementation → initial_v → initial_r → repair → recheck_v → recheck_r` 的阶段屏障执行。全部 M 完成才能 V；可继续验证的 Task 全部 V 通过才能 R；`waiting_human_review` 的 Task 暂挂，独立 Task 继续 R。第一轮 V/R 的问题归入一次集中返工，第二轮任何失败均终止自动派发并保留最终 HEAD、Evidence 与问题清单。每一阶段的同一 Task/角色最多自动派发一次；基础设施重试不可绕过两轮上限。已有 V/R/返工状态采用旧调度直到其波次收尾。因同一波次 Task 依赖必须先成为 Candidate 才能启动，下游 Task 应排入后一波；启动前拒绝这种范围，避免阶段屏障死锁。`--single-stage` 维持诊断旧流程。波次共享并发、耗时、Token 和费用上限，不给每个阶段重置预算；缺失用量或费用时仍熔断并保留事实。

工单进入波次时，未显式列出 Task 的执行只纳入当下 Ready 集合；没有 Ready Task 时拒绝创建空波次。显式 `--task` 的只读预览与执行采用同一 Task 范围，并显示所选工单的等待原因。Candidate 基线漂移只在该波次选中的 Task 上重新排队；全项目只读规划仍可报告全部 Candidate。阶段切换仅重算本波次范围内的就绪状态，不重查无关历史 Candidate。

Review 权威记录保存在 `.spec-loop/scheduler/wave-reviews/WAVE-*.json`，Task hold 在其 `tasks/` 下，下一波一次性授权在 `authorizations/` 下。记录包含最终 AC、实际干净 HEAD、Contract/Run/Plan/角色记录摘要、V/R Evidence、注册视觉截图、失败和费用，以及下一波具体 Task 范围和预算。清单有效期为 24 小时、最多 200 个 Task、单记录最多 1 MiB。重新绑定创建新的不可变清单，只收纳尚未决定的 Task；旧决定和旧 hash 不复用。未使用或启动失败的下一波授权可撤销后重新绑定，运行中或已经完成的授权不能重复启动。

清单发布与决定共用互斥，并在锁内核对 Task hold 归属：普通波次只能接管尚无 hold 或已释放的 Task；刷新只能替换仍归属原清单的待验收/已释放项。并发刷新、旧波次迟到发布或旧清单再次刷新均不得覆盖新清单或已接受项，失配时保留当前归属并报告过期。

CLI 提供 `scheduler control wave-review list/show/refresh/decide` 和 `run-approved --authorization <uuid>`。本地看板提供“波次末统一验收”：逐项接受、退回 M、按原范围继续或暂缓，展开检查 AC、Evidence 和截图；提交时可同时明确批准并启动下一波。接受候选必须重新核对权威事实、证据文件内容和视觉历史；Heavy 需要显式人工接受，原返工预算耗尽时必须显式重批原预算。接受不触发 merge、push 或发布。

审批按 request ID 和输入摘要记录回执，先校验整批再执行，逐项保存应用进度，最后原子释放接受/返工 Task 的 hold 并发布下一波授权。崩溃或网络中断后重试沿用原决定；事实变化、过期、越出清单范围、Gate/预算或控制状态变化均拒绝旧输入。下一波只包含本次明确退回或继续的 Task；已接受及暂缓项不被夹带。

看板只新增 `/api/wave-review/decision`、`/refresh` 两个 POST 入口，保留其他原只读入口的约束；写入口要求本地 Host/Origin、服务实例 capability token、严格 JSON 和有界请求体。截图只能读取清单登记的 Task 内文件，核对文件类型、真实路径、图像格式和 SHA256。既有执行投影新增 `awaiting_wave_review`，避免把尚未统一验收的 Candidate 显示为已交付。

watchdog 停止意图绑定当时观察到的 Invocation/Effect/Driver/Wave 与 PID 启动身份。停止 Worker 在 Task 停止互斥内重新核对该观察；旧执行已经结束、恢复或被新阶段替代时标为 superseded，不取消新阶段。新 Task Lease 准入共用该互斥，防止重核与下一阶段启动交错；用户 Kill 和预算熔断仍保留无条件停止语义。

### 常驻监督、恢复与产物保留

- 2026-09-26 防卡死补充：Role Provider 与 watchdog Worker 共用 Managed Process；仍存活但无法确认启动身份时拒绝成功结果并停止自有子进程。已经在身份查询前正常退出的快速命令保留真实退出结果。
- 进程停止使用单调时钟的总 deadline，身份探针和 TERM/KILL 等待共享剩余额度。查询失败不等于死亡：只有 PID 已消失或原启动身份已结束才确认停止；身份未知或总期限耗尽时保留 `stop_incomplete`。
- 高频心跳使用可取消的单文件遥测写入，不生成可恢复 journal；超时后在排队结束和提交前检查 AbortSignal。终态写入和 marker 删除与心跳共用事务互斥，已提交到内核的 rename 按顺序完成，不能在终态之后覆盖或重建 marker。权威业务事实继续使用可恢复事务。
- `run-ready --execute` 必须绑定健康的独立 Supervisor；Supervisor 使用 PID 启动身份、单实例锁和自身心跳，每个 watchdog cycle 由独立超时子进程承担。Controller 心跳与 Provider/Effect 的可观察工作进展分开记录；stderr、重复输出、心跳和单纯 usage 增长不延长进展期限，长期无进展会熔断。
- report-only 扫描锁和 Scheduler 控制锁都绑定 PID 启动身份；死亡 owner 可回收，缺失 owner 只在超过保护窗口后回收。Pause、Resume、Kill、reconcile 与 Lease 变更共用控制互斥区，保证 Pause 返回后不会再有并发的新 Lease 穿透。
- watchdog cycle 超时或输出越界时必须先验证子进程树已经退出，再清除 Worker 标记和调度下一轮；无法验证退出时 Supervisor 保持 degraded，禁止用“已发送信号”代替“已停止”。
- 所有控制面目录锁统一使用 `pid + process_started_at + nonce + created_at`；死亡/PID 复用 owner 通过 rename 隔离后回收，缺失 owner 遵守保护窗口，释放前必须核对 nonce。
- `missing_owner` 与半写/损坏的 `invalid_owner` 使用同一创建保护期；回收由 `<lock>.recovery` 互斥，并在 rename 前复核目录 inode 与 owner 摘要。业务操作和锁释放同时失败时保留业务原始异常。
- recovery mutex 的等待受调用方外层绝对 deadline 约束；`maxWaitMs: 0` 只做一次非阻塞获取，不能被内部恢复等待扩展为十秒。
- 跨根事务的 recover、prepare、journal commit 和最终 recover 共用 `.spec-loop-cross-tx-lock`，禁止两个恢复者同时处理同一 journal。
- 波次和 Supervisor heartbeat 采用 latest-value 合并写：最多一个 in-flight 和一个最新 pending 快照；终态必须 flush，写入超时或连续失败时停止新派发。
- Provider、Gate 与运行时探针统一使用 Managed Process：执行期限和 pipe drain 期限分离，根 PID 退出后不再因逃逸孙进程持有 stdout/stderr 而无限等待，并记录停止确认与排空超时事实。
- Wave Driver 无法取得 PID 启动身份时，在启动 Supervisor 或写入波次记录前失败；`launchctl` 和手工工作命令同样具有确定硬超时。
- Supervisor 只有在至少一次 `ok:true` watchdog 后才健康；`ok:false` 计入失败。连续失败的 circuit 持久化且只能显式 reset，十分钟最多自动重启三次。
- watchdog 先为全部目标落盘 stop intent，再以最多四路并发、单任务三秒期限停止；超时写为 `stop_incomplete` 并由下一轮继续 reconcile，保留汇总持久化时间。
- Project/Task Lease 以原 fencing token 和 owner nonce 续租且不得超过波次绝对截止时间；基础设施失败进入 RetryWait，相同指纹重复或确定性工具错误进入 DeadLetter。
- 资源声明支持仓库/分支及模块父子冲突、读写模式和工具容量；Ready 排序使用等待年龄、下游阻塞与重试惩罚，但不得绕过风险确认。
- Candidate baseline 漂移会保留旧 Candidate 事实、作废旧 V/R 绑定并自动重新排队，不静默复用 PASS。成功 invocation 若尚未摄入，明确进入等待摄入而不是继续计时。
- Project 级 `.spec-loop/shared-cache/` 复用 npm/Maven 下载；Evidence archive 只复制 Contract、Run、Plan、角色 manifest、Gate 与 hash Evidence，排除可重建候选快照。
- 波次预算先按并发槽位从同一剩余 Token/费用中 reservation；波次 Driver 记录 PID 启动身份和心跳，崩溃后对账角色结果并进入 `interrupted_requeued`，不得重复使用旧的运行中投影。
- Dashboard Snapshot 上限 256 KiB；历史/当前/未启动状态分离。macOS 可审核 `launchd` 模板用于重启后恢复 Supervisor，安装和卸载必须由用户显式 `--apply`；Supervisor 每日只做有界、非破坏性的终态 Evidence 归档，不自动删除历史或 worktree。

### 2026-09-26 补充：停止事实与健康检查

- 本轮继续加固 AC-12/13/16：重复/仅心跳输出和单纯用量增长不算工作进展；Provider 用量明确采用累计或分次模式，累计值倒退或字段矛盾不能证明预算，分次事件逐条摄入并去重。
- 启动探针按身份互斥复用，继承波次取消和剩余额度，实际探针消耗归入同一波次；未知用量仍 fail closed。
- 下一波授权保存 Worker 的 PID、启动身份和关联波次；Worker 死亡后核对波次终态，保留已完成事实或进入可重新绑定的失败状态，不长期残留 running，也不自动复用旧授权。
- 波次生成验收清单使用独立、有界控制 Worker；收尾失败明确保留未完成状态并暂停新派发，不用清单生成成功的假设替代实际结果。
- 本地看板区分存活与响应健康，启动/停止互斥且具有真实总 deadline；短暂响应慢不删除存活进程标记。历史事件按文件身份缓存已验证内容、按段流式校验，快照计算合并同一时刻的并发请求。
- 收尾 Worker 在独立期限和 Project fencing 下生成清单；失败暂停，显式 `wave-review rebuild` 仅重建已核实停止的收尾，不恢复业务派发。后台授权对账逐条隔离损坏记录，并轮转有限批次。
- 已核实的直接停止重试只能完成操作前观察到的 intent 代际；Kill 同时重试历史未完成 intent。Effect 停止标记在停止凭据落盘后才清理，中途死亡仍可恢复核实事实。

- 进程检查区分存活、死亡、PID 复用和身份未知；查询失败不能触发锁/recovery mutex 回收、Role interrupted 或 Supervisor 自动替换。
- Managed Process 的结果完成与退出核实是两个事实；重复/并发 terminate 共用在途停止操作，未核实停止不能因 completion 已完成而变成成功。
- Role/Effect/Wave 心跳必须是有效 ISO 时间，异常未来时间、损坏 JSON 和非法超时配置不能投影为 healthy；损坏记录独立报告，不中止其余记录检查。
- 波次熔断、Kill 和 watchdog 共用停止批次：先记录全部 stop intent，再由最多四个受控子进程执行停止；单任务默认三秒，整批默认十秒，清理和汇总使用剩余额度。每个 Task 的停止有独立互斥；重复请求会重新核实未完成 Role/Effect/Driver。
- stop intent 以 request ID 和代际互斥更新；旧请求不能覆盖新请求，同一代的迟到准备不能把终态退回 requested。结果落盘未核实时返回 stop_incomplete。
- 熔断向角色传递 AbortSignal，在 Provider 启动前重新检查取消状态；波次收尾不继续等待原 Worker 全部返回。未核实停止进入 pending_stops 并暂停新派发，后续 watchdog 重试；reconcile 不能在未完成 intent 存在时恢复。

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| 重叠 Scheduler | 重复 Proposal/Task | project lease + idempotency | rebuild/report reconcile |
| 旧 Worker 双写 | 状态/代码冲突 | fencing token | 拒绝旧结果、丢弃 worktree |
| Connector 越权 | 外部损害 | per-project minimal scope | revoke token/pause project |

## 验证策略

report-only 指标、并发/冲突、Worker crash、Pause/Kill、Denylist、Connector 权限和多个真实低风险 Dogfood。

## 工单拆分

| 工单 | 交付物 | 依赖 | 状态 |
|---|---|---|---|
| [TASK-034](../04-task/TASK-034-report-only-scheduler.md) | 幂等 report-only 扫描、建议与质量指标 | TASK-032 | 已完成 |
| [TASK-035](../04-task/TASK-035-scheduler-leases-controls.md) | Lease、fencing、resource claim、Pause/Kill 和受控 Ready 调度 | TASK-034 稳定 | 已完成 |
| [TASK-026](../04-task/TASK-026-feishu-heavy-dogfood.md) | 飞书真实连接器专项 Heavy | 真实配置、TASK-021～025 | 已批准 |
| [TASK-037](../04-task/TASK-037-phase4-pmvr-heavy-dogfood.md) | Phase 4 自动闭环最终 Heavy | 全部 Phase 4 子 Task | 已批准 |

## 实际实现

- 最终实现：report-only 的 TASK-034 AC-1～5 与 Lease、fencing、resource claim、Pause/Kill/reconcile、denylist、整波两轮流程的 TASK-035 AC-1～17，均在候选 `cbc1a5d` 上独立 V/R PASS。用户已完成绑定截图哈希的人工视觉 Review，两个工单均关闭；Phase 4 最终 Heavy 仍单独验收。报告与 Wave Review hold 共用受 Review 决定约束的读取边界，伪造终态不能绕过待审状态。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 融合 Scheduling、多任务与安全 | 最终 Roadmap | - |
| 2026-08-04 | 引用飞书正式机器人专项设计与草稿工单 | 将通用 Connector Policy 与具体双向交互实现分层 | TASK-021～026 |
| 2026-09-04 | 拆分 report-only、受控调度与最终 Heavy | 对齐最新版 P/M/V/R，保持“先报告后执行”和唯一全量验收 | TASK-034、035、037 |
| 2026-09-19 | 补充防卡死边界 | 明确死亡锁回收、控制状态串行化与 watchdog 退出确认 | TASK-035 |
| 2026-09-19 | 完成对抗性收敛加固 | 增加跨根事务锁、锁回收 CAS、Managed Process、持久熔断与并发停止 | TASK-035 |
| 2026-09-26 | 确立波次末统一人工验收 | 避免阶段级确认打断连续执行，同时保留权限、预算与安全即时熔断 | TASK-035 |
| 2026-09-30 | 将波次降为内部机制，用户级改为规格库轮次 | 同轮盘点全部未完成工单，集成后集中测试与裁决，避免逐波次打断 | TASK-026、028、029、033、037 |


### 2026-09-27 复查修复范围

- Role Invocation 记录波次、Project/Task lease ID 和 fencing token；波次恢复及 watchdog 只处理能核实归属的执行，在 Task 停止互斥内重核，外来租约或未绑定历史记录受保护。租约准入成功后才发布 running 波次，准入失败不留下可误恢复的记录。
- 累计用量合并已知组件后派生总量，分次事件按局部 ID 或封包内位置去重；纯数字状态/遥测不延长真实进展期限。
- Execution Events 兼容旧单文件，流式验证每行与全局哈希链；8 MiB 分段后原子发布归档索引和当前段，保留全部历史及未结束步骤。显式 `maintenance archive-events` 封存当前段，索引拒绝缺段/整段丢失；读操作不执行事务恢复写入，写操作先恢复事务。
- 待验收和 applying 记录不受最近 20 条已完成历史限制；损坏 Review/Wave 逐条报告，不阻塞其余记录，损坏项不能直接验收。GUI 提交成功后同步波次列表和候选行的已保存决定。
- 本轮是 TASK-035 AC-12/13/16 的范围内修复和定向反馈，不提前关闭完整工单或执行最终 Heavy。

### 2026-09-27：启动与巡检开销

内部 Provider Doctor 以 executable stat 身份、参数和运行环境作为 30 秒复用键，并发共用检查；失败清除缓存，显式 Doctor 始终重新检查。启动探针只复用相同配置内容、凭据内容、可执行文件身份与权限能力的结果：V/R 启动能力相同，正式角色执行与 Candidate snapshot 仍分别隔离；M 单独探测。mtime 变化不作配置内容变化。探针使用项目外独立临时 Git workspace，避免继承目标工程的目录说明；终止未经核验时保留现场。健康检查只在本次调用内复用租约与执行记录，任何实际停止或恢复都重新读取锁内权威状态，不跨巡检周期缓存所有权。
