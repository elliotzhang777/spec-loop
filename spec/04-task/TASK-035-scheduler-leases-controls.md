# TASK-035：Scheduler Lease、资源协调与 Pause/Kill

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-09-29
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

- [x] AC-1：同一 Project/Task 不会被两个有效 lease 同时写入，过期 Worker 的结果被 fencing token 拒绝。
- [x] AC-2：冲突资源严格串行，无冲突任务只在批准范围和预算内并发。
- [x] AC-3：Pause 不启动新动作；Kill 取消运行、保留现场并要求 reconcile 后才能恢复。
- [x] AC-4：崩溃、时钟漂移、PID 复用、重复回调和陈旧结果均不能形成虚假 PASS 或 Candidate。
- [x] AC-5：Denylist 阻止 merge、push、deploy、凭据、生产数据和未批准外部副作用。
- [x] AC-6：关键路径、高风险和下游阻塞符合最新版架构的人工升级规则。
- [x] AC-7：Task 停止先落审计事件，再取消角色、Run 与 lease，保存实际 Worktree HEAD，回收死亡 Driver 锁；重复停止不追加第二个取消事件。
- [x] AC-8：只读维护盘点能定位 worktree、node_modules、Maven cache 和大文件，只把 delivered/cancelled worktree 列为退休候选，绝不自动删除。
- [x] AC-9：显式 `run-ready --execute` 在同一波次并发启动无冲突 Ready Task，并由波次时间、Token、费用预算熔断；usage 缺失时 fail closed。
- [x] AC-10：事务 journal 在并发 Worker 间互斥，任何 Worker 都不能恢复或删除另一个尚未完成的事务。
- [x] AC-11：Worktree 退役默认只预览；只有终态、干净、无活动 Effect/lease 且显式 HEAD 相符时才移除目录，并保留 branch、manifest 和退役记录用于恢复。
- [x] AC-12：运行中的角色和 Effect 持续写独立心跳；健康检查能识别死亡 PID、陈旧心跳、死亡 Driver 与过期波次；独立常驻 Supervisor 以单实例、可核验 PID 身份和自身心跳持续执行受超时隔离的 watchdog，并自动停止不健康 Task。
- [x] AC-13：Git、Candidate snapshot 和工具控制面子进程均有确定超时，不能无限等待文件系统、hook 或管道关闭。
- [x] AC-14：Dashboard 提供角色心跳、deadline、熔断剩余时间、实时 Token 与结果摄入状态；Snapshot 不超过 256 KiB。
- [x] AC-15：Supervisor 提供不自动安装的 launchd 恢复计划；Evidence 可持久归档，依赖下载使用 Project 共享 cache，并保留显式、可审核的退休策略。
- [x] AC-16：已批准 Task/波次内普通 Gate、范围内修复和新 HEAD 的 V/R 不重复申请执行授权；执行授权与具体 HEAD 验证证据分离；`needs_user` 不逐项打断用户；受影响 Task 保存事实并让路，波次结束后以绑定 HEAD/计划 hash 的 Wave Review Bundle 统一验收。只有破坏性、越权、预算越界、安全风险或状态无法对账可即时暂停对应范围。
- [x] AC-17：新启动的完整波次先完成全部 M，再对整波执行 V；全部可继续验证 Task 的 V 通过后才进入 R；待人工确认的 Task 暂挂，独立 Task 继续。初验失败只集中返工一次，再进行第二轮 V/R；第二轮仍失败即停止自动派发并保留问题和证据，不启动第三次 M。已有 V/R 状态或已有返工记录的执行保持旧流程；同波次未满足 Candidate 的依赖在启动前拒绝，提示拆波。阶段、轮次和停止原因保存在波次记录中。

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
- 2026-09-26 产品决策：人工确认默认收敛到波次末；Gate 继续自动运行。普通待确认 Task 转入 `awaiting_wave_review` 并释放资源，独立任务继续执行；最终统一展示 Wave Review Bundle，并可同时授权下一波计划。
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
- 2026-09-19 防卡死加固：心跳拆分为 Controller 存活与 Provider 真实输出/usage 进展；默认 300 秒无进展即 TERM→KILL，并用 PID+启动时间防止复用误杀。
- 波次记录增加独立心跳、活动/待派发任务、全局 usage reservation 与有界 ledger；Driver 崩溃后显式对账为 `interrupted_requeued`，不把旧运行继续投影为活跃。
- 默认波次预算收紧为并发 2、20 分钟、25 万 Token 和 10 美元；并发 Worker 从同一个剩余额度预留，不能各自获得整波次预算。
- Supervisor 支持显式 `--apply` 安装/卸载 launchd，且每天最多为 5 个终态 Task 执行非破坏性 Evidence 归档；不自动删除 worktree 或历史。
- 增加快速退出 Provider 竞态回归：在任何异步 PID 查询前注册 stdout/stderr/error/close，避免退出事件丢失后等待到硬超时。
- 2026-09-19 锁与监督加固：report-only 锁和 Scheduler 控制锁记录 PID 启动身份并回收死亡 owner；Pause、Resume、Kill 与 reconcile 的控制状态切换和 Lease 使用同一互斥边界，避免 Pause 与新派发交错。
- watchdog 达到周期超时或输出上限后，先按 PID 启动身份执行 TERM→KILL 并确认旧 Worker 已退出，再清空 Supervisor Worker 标记和进入下一轮，避免重叠 watchdog 晚写状态。
- 控制面锁统一迁移到 `OwnedDirectoryLock`，心跳迁移到有界 latest-value writer；health 输出锁 owner/年龄/等待/回收、Lease 剩余时间、预算比例、等待摄入结果和 Supervisor 写入指标。
- Supervisor 对 stale heartbeat 自动安全替换，首次 watchdog 成功前不派发，连续失败达到阈值后熔断；测试模式具有 session ID 与最大生存期。
- Scheduler 增加 Project/Task Lease 续租、RetryWait/DeadLetter、层级/读写/容量资源声明、公平性评分和有界 SLO 汇总。
- 对抗性复核后补齐跨根事务全周期互斥；100 个并发跨根事务不再竞争创建 journal/temp 目录或重复恢复同一 journal。
- Owned Lock 的损坏/半写 owner 与缺失 owner 都遵守创建保护期；回收使用独立 recovery mutex 和 inode/owner 摘要复核，50 个恢复者只能形成一个有效持有者。
- Provider、Gate 和 Provider Doctor 探针统一迁移到 Managed Process；根进程退出与 stdout/stderr 排空分别设限，逃逸孙进程持管道不会阻塞完成 Promise。
- Supervisor circuit 持久化到控制面，`ok:false` watchdog 计为失败，自动重启十分钟最多三次；新增 `supervisor-circuit-status` 与显式 `supervisor-circuit-reset`。
- watchdog 为全部目标先写 stop intent，再以四路有限并发和单任务期限执行停止；未完成项保留 `stop_incomplete` 供下一轮继续 reconcile。
- recovery mutex 继承调用方剩余 deadline，`maxWaitMs: 0` 遇到活动恢复者会立即返回 busy；Wave Driver PID 启动身份缺失时禁止启动。
- `launchctl` 使用 10 秒 Managed Process，`activity run` 默认 300 秒且支持 `--timeout-seconds`，消除两处非主路径的无限等待。
- 2026-09-04 快速反馈：编译通过；`test/scheduler-control.test.mjs` 1/1 通过。尚未执行正式独立 V/R。
- 2026-09-19 快速反馈：`npm test` 215/215 通过；未启动业务波次，未执行新的正式独立 V/R，工单仍保持“待验证”。
- 2026-09-19 本次定向反馈：编译通过；`report-scheduler`、`scheduler-control`、`process-control` 共 8/8 通过，覆盖死亡锁回收和 watchdog 超时无重叠；未执行新的正式完整 Gate。
- 2026-09-19 防卡死扩展反馈：统一锁/合并写/失联恢复/续租/失败队列/资源模型定向回归通过；完整 `npm test` 最终 221/221 通过，并修复停止结果幂等字段及固定等待导致的飞书测试竞态。
- 2026-09-19 对抗性收敛反馈：半写 owner、50 恢复者、100 跨根事务、setsid 孙进程持管道、持久 circuit 和 watchdog 并发停止均有回归；最终完整 `npm test` 228/228 通过。未启动业务波次，未执行正式独立 V/R。
- 2026-09-19 deadline 收尾反馈：recovery mutex 严格继承外层剩余 deadline，Wave Driver 身份缺失时 fail closed，`launchctl` 与 `activity run` 具有确定超时；同进程锁身份缓存避免并发 Lease 在控制面 `ps` 抖动下耗尽等待预算。最终完整 `npm test` 230/230 通过。未启动业务波次，未执行正式独立 V/R。
- 2026-09-26 延续上次防卡死审计：补齐 Role/watchdog 存活子进程启动身份准入、单调时钟停止总 deadline 和可取消心跳遥测；查询失败不再被当作死亡，心跳不进入恢复 journal，终态/删除与在途写入共用互斥。范围对应 AC-12/13，工单仍待正式独立 V/R；波次末统一验收 AC-16 本次尚未实现。
- 2026-09-26 快速反馈：构建及最后候选 TypeScript 编译通过；底层定向组 19/19、调用链组 32/32、收尾组 23/23 通过（去重后共 53 个用例）。覆盖身份缺失、慢探针总期限、迟到心跳、替换 owner 防误删、Supervisor 启动失败释放锁与信号监听器，以及既有角色隔离/取消、Gate、结果摄入、事务和波次监督；未运行完整正式 Gate。

## 2026-09-26 后续四项修复（快速反馈）

- 修复 Managed Process 已返回未核实结果后，重复 terminate 错误返回成功的问题；并发停止共用同一在途核实。
- 健康检查拒绝非法/异常未来时间，逐条隔离损坏 Role/Effect/Wave 心跳；不再因 NaN 比较失败而显示 healthy。
- 锁、recovery mutex、Role reconcile、Driver 与 Supervisor 对身份未知保留现场，只有已确认死亡或 PID 复用才回收/标为 interrupted。
- 波次熔断、watchdog 和 Kill 使用先落盘 intent 的有界停止批次；补齐整批 deadline、子进程清理、请求代际保护、取消启动检查和未完成停止重试。未核实停止不修改 v1/v2 为取消成功，重复 stop-task 会继续核实。
- TypeScript 编译与差异空白检查通过；定向组 36/36、角色隔离/取消、实时 usage 熔断与实际 HEAD 停止组 3/3 通过，去重共 39 个用例。停止批次顺序调整后直接相关组 4/4 复核通过，最后代际保护及完整 intent 先行断言 2/2 通过；未运行全量回归或正式独立 V/R。
- 本次仍为 AC-12/13 的实现与定向反馈；AC-16 波次末统一验收继续保留待实现，不将修复扩大为新的业务流程或正式交付。

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
| 2026-09-19 | 防卡死与质量加固 | 增加真实进展熔断、PID 身份停止、波次崩溃恢复、全局预算 reservation、定时非破坏性归档与故障注入回归 |
| 2026-09-19 | 锁恢复与 watchdog 串行化 | 回收死亡扫描/控制锁、串行化控制状态切换，并在 watchdog 超时后核验旧 Worker 退出 |
| 2026-09-19 | 调度防卡死闭环 | 统一锁、合并心跳、Supervisor 恢复、Lease 续租、DeadLetter、层级资源和 SLO |
| 2026-09-19 | 对抗性复核修复 | 完成跨根事务互斥、半写锁保护、硬超时收敛、持久 circuit 与 watchdog 有界并发停止 |

- 2026-09-26 用户反馈修正规则：取消同一范围每次候选变化都重批正式 V/R 的要求，集中最终确认；同步本仓库约定、海工工程前后端 AGENT 和新模板 v6（2.1.1），保留旧发布模板不可变。此项先修正规则入口；自动 Wave Review Bundle/统一审批 UI 仍待实现。

## 2026-09-26 波次末统一验收实现候选

- 按用户“全部都做”的继续实施指示，补齐 AC-16：同一批准范围内连续 M/V/R 和受控 Gate，V 失败按原预算回 M，新 HEAD 自动复验；普通 needs_user 保存事实并释放资源，独立任务继续至 R。
- 实现不可变 Wave Review Bundle、Task hold、批量决定回执和下一波一次性授权；本地 UI 汇总 AC、HEAD、V/R、Evidence、截图、失败、用量与费用，支持部分接受、返工、继续、暂缓及“验收本波并启动下波”。
- 拦截过期/hash 失配、证据或运行时记录变动、未完成视觉 Review、未明确接受 Heavy、返工预算耗尽和下一波 Gate/预算/控制状态变化；保留原截图历史校验、目录边界和只读 API 约束。接受候选不自动合并或发布。
- 审批中断沿用原输入和 command receipt 恢复，逐项保存进度；未使用或启动失败的授权可撤销并重新绑定，不能重用已消费授权。watchdog 停止前重核原执行代际，避免旧阶段的结束被误读为新阶段故障。
- 当前仍是待验证的实现候选。定向集成和 Playwright 证据见 [调度实现与防卡死审计](../05-delivery/2026-09-19-任务调度实现与防卡死审计.md) 的本次补充；不据此勾选整个工单、启动真实业务验证或推进最终 Heavy。

## 2026-09-26 继续收尾

- 用户继续要求优化空跑与卡死因素；本轮在 AC-12/13/16 内补强进展判定、用量统计、启动探针、授权崩溃恢复、有界收尾及看板控制/历史读取。保持原任务范围和正式验收边界，最终结果追加到同一审计。

- 复现并修复旧清单/旧波次覆盖新 Task hold：清单发布在同一决定互斥内核对归属；刷新绑定原清单代际，不能接管新清单或已接受项。
- `test/wave-review.test.mjs` 4/4 通过，覆盖并发刷新只有一个有效接管者，以及既有自动返工、部分验收、待确认让路、控制/预算重绑和缺失报告字段后的新 V/R 路径。
- 最后候选真实 Chromium 连续流程通过，7 张夹具截图与自动源码/构建摘要已归档；实际看板保留原端口重载，接口 200、控制台无错误。详见上述审计的“继续收尾与清单归属保护”。
- 同步两个看板和 Roadmap，清理“每个候选必须重新授权正式 V/R”的过期阻塞文字，保留范围、依赖、预算与最终 Heavy/视觉决定。
- 本次结果属于已批准优化范围的实现与定向验证；完整 TASK-035 的独立验收仍未完成，未将夹具 Provider 的 V/R 冒充真实业务验证。


## 2026-09-26 空跑与中断恢复优化结果

- 落实噪声去重/单调进展期限、累计/分次用量配置、可取消且计入预算的单实例探针、后台授权死亡对账、15 秒有界清单收尾与显式暂停重建、慢看板身份保护和事件缓存。
- 定向回归复现并修复停止凭据恢复缺口：直接核实停止只完成原 intent 代际，Kill 重试历史未完成项；Effect 标记在凭据落盘后才清理，避免停止 Worker 中断后丢失事实。
- 构建、差异检查及去重 65 个定向用例通过；初次 Scheduler 失败按错误指纹修复并复验，未重复全量回归。最后源码的真实 Chromium 流程 `2026-09-26T15:12:37.928Z` 通过，7 张夹具截图/32 项摘要；实际看板原端口只读 smoke 通过。
- 完整验证记录与边界见 [防卡死审计](../05-delivery/2026-09-19-任务调度实现与防卡死审计.md) 的“继续优化空跑、预算与中断恢复”。本工单仍待正式独立验收及必要人工视觉决定，未启动真实业务角色或最终 Heavy。


## 2026-09-27 复查后代码修复

用户明确要求修复复查发现的六处问题与验收列表同步。沿用 AC-12/13/16：补齐执行代际绑定、分批 usage 合并、数字噪声过滤、流式事件分段/归档完整性、未验收历史可达性及损坏记录隔离；验证结果追加到同一防卡死审计。仍保持待验证，未扩大到新业务或最终 Heavy。


- 2026-09-27 收尾结果：构建/差异检查及去重 59 个定向用例通过；初次停止状态断言按 request ID 修正并复验通过，停止核实规则未放宽。最终 Chromium `2026-09-26T17:13:39.206Z` 通过，7 张截图和 42 项摘要；波次列表与候选行均显示已保存决定，实际看板接口 200、无控制台错误。详见 [复查修复审计](../05-delivery/2026-09-19-任务调度实现与防卡死审计.md) 的本次补充。完整工单仍保持待验证。
- 2026-09-27 运行开销优化（AC-12/13）：内部 Provider Doctor 按可执行文件身份、参数和环境短时复用（30 秒），同身份并发合并；失败不缓存，显式 Doctor 保持实时检查。启动探针按配置/凭据内容识别身份，V/R 共用同权限启动能力检查，M 独立；探针在独立临时 Git workspace 执行并于确认进程终止后清理。单次健康检查复用租约和角色记录，停止/恢复仍在锁内读取最新身份。6 个定向用例通过；真实 Token 降幅尚待后续执行日志观察，工单仍待正式验收。
- 2026-09-27 用户要求收敛执行复杂度：普通修改按定位、集中修改、一次最小检查和结果汇报执行；约定与角色提示限制为当前工单及直接相关文件，扩大检查须有具体错误或 AC 缺口，不在等待时预读后续任务，不追加无依据的审查轮次。正式 V/R 按已有批准计划保留。
- 2026-09-28 波次节奏改造候选（AC-17）：全新波次以 M、第一轮 V、第一轮 R、一次集中修复、第二轮 V/R 为阶段屏障；同一 Task/阶段最多自动派发一次，第二轮仍失败停在本波次验收。已有 V/R/返工状态继续旧流程；待人工确认的 Task 暂挂，独立 Task 继续；同波次 Candidate 依赖在启动前拒绝。新波次记录写入执行模式、阶段、轮次和停止原因，Review Bundle/界面展示最终轮次与未完成原因。定向集成和浏览器结果见交付审计。工单仍待完整独立 V/R。
- 2026-09-28 海工项目看板续航修复（AC-13）：74 个 Task 的快照旧压缩后仍达 282,436 字节并返回 HTTP 500。增加历史 Task 步骤的第二级有界压缩，保留全部 Task、当前 Task 最近 5 步和历史 Task 至少 1 步；当前源码构建和 2 个定向回归通过。看板在原端口重启后 `/api/snapshot` 返回 200、74 个 Task、262,009 字节。完整独立 V/R 和必要人工视觉 Review 仍待完成。
- 2026-09-28 波次规划效率与范围修复（AC-17）：海工项目积累 53 个历史 Candidate 后，全项目规划的串行 Git 基线核对实测约 20.6 秒，其中 49 个基线漂移。新波次准入仅核对并处理本波明确选中的 Candidate，未选中候选保持原状态；阶段切换不重复基线核对。显式全项目规划仍完整报告所有候选，检查最多四路只读并发。范围隔离回归和原有完整波次回归通过；详见交付审计。
- 2026-09-28 工单到波次准入补强（AC-17）：未传 Task 范围时仅选 Ready 工单，空集合在创建波次前拒绝；`--task` 预览与执行采用同一范围，等待原因可见。目标夹具隔离回归与海工只读定向预览通过；完整正式 V/R 未据此关闭。
- 2026-09-28 当前源码浏览器复验（AC-16/17）：独立夹具的整波验收、部分决定、下一波授权、新 HEAD 的 M→V→R 和移动端交互通过；45 个源码/构建摘要及 7 张截图在结束后复核一致，报告位于 `.spec-loop/output/wave-review-browser-current/report.json`。此为功能反馈，不替代完整工单独立 V/R 或人工视觉验收，工单继续待验证。
- 2026-09-28 固定候选回归：隔离候选 `9450de2` 的定向组初跑 67 个用例中 65 通过、2 失败。Supervisor 启动超时在无并发负载下单独复验通过；缺字段 V 结果虽正确拒绝，却让同波独立 Task 停在 `v_passed`，已修复阶段判断排除该波次已停派 Task，原失败用例复验通过。新候选构建、报告/阶段 5 个短用例及真实 Chromium 路径通过；45 个文件摘要、7 张截图绑定干净 HEAD，报告位于 `.spec-loop/output/wave-review-browser-candidate-9450de2/report.json`。这些仍是隔离候选的实现反馈，不宣称完整工单正式独立 V/R 或人工视觉验收完成。
- 2026-09-28 最终测试与文档快照 `fcb715d`：报告夹具补齐多 Project、过期/跨 Project cursor 和非法反馈后，定向 5/5 再通过；真实 Chromium 路径重新绑定此干净 HEAD，45 个文件摘要与 7 张截图复核一致，见 `.spec-loop/output/wave-review-browser-candidate-fcb715d/report.json`。执行代码与 `9450de2` 相同，完整独立 V/R 和人工视觉验收仍待完成。
- 2026-09-29 前置 TASK-034 已在干净候选 `cbc1a5d` 上独立 V/R PASS，report-only 稳定门槛满足。相同候选重跑真实 Chromium 波次路径 PASS，报告 `.spec-loop/output/wave-review-browser-candidate-cbc1a5d/report.json`；45 个源码/构建摘要、7 张截图逐项复算一致，控制台错误 0。浏览器模块默认期待未缓存版本的首次启动失败；明确指定本机已缓存 Chromium 后通过，未修改候选。TASK-035 仍待自身完整独立 V/R 与必要人工视觉验收。
- TASK-035 独立 V/R 均对同一干净 HEAD `cbc1a5d4f8d531a2a814af1a1a3bd50489c2f73c` 给出 PASS，逐项覆盖 AC-1～17；证据 `.spec-loop/output/TASK-035-V-cbc1a5d.json`、`.spec-loop/output/TASK-035-R-cbc1a5d.json`。V 的定向测试 90/90 PASS，R 最小复核波次状态机 4/4 PASS，并独立核对浏览器 manifest 45/45 与截图 7/7 的 SHA-256。TASK-034 前置同 HEAD V/R PASS。当前工单仅待用户对界面截图的人工视觉 Review；未运行 Phase 4 最终 Heavy、真实海工业务角色或合并/发布，不据此标记“已完成”。
- 用户于 2026-09-29 明确确认“视觉没问题，继续”。人工视觉决定已绑定同一候选 HEAD、V/R 报告、Chromium 报告和 7 张截图哈希，记录于 `.spec-loop/output/TASK-035-visual-review-cbc1a5d.json`。AC-1～17、独立 V/R 和必要视觉 Review 均完成；实现与 DES-005 波次设计一致，差异及修复记录见交付审计。TASK-035 关闭。该决定不授权 Phase 4 Heavy、真实海工业务角色、合并、推送或发布。
