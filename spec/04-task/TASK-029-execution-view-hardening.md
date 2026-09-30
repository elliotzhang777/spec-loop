# TASK-029：执行可视化兼容重建、Dogfood 与加固验收

- 状态：进行中
- 优先级：P1
- 负责人：待定
- 创建日期：2026-08-12
- 最后更新：2026-09-30
- 所属设计：[DES-009](../03-design/DES-009-execution-visualization.md)
- 所属特性：[FEAT-009](../02-feature/FEAT-009-execution-visualization.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-027、TASK-028
- 任务等级：Heavy
- 协议版本：P/M/V/R v2
- 所属批次：P4-B4

## 目标

证明执行可视化可以在旧 Project、当前 spec-loop 自托管 Project 和大规模 fixture 上安全重建，并用最终 Heavy 验收关闭兼容性、性能、隐私、故障恢复和真实使用风险。

## P/M/V/R v2 对齐

- P：把旧数据、自托管、性能、安全、浏览器、视觉与 view 生命周期用例冻结为完整 Heavy Contract，并由人批准精确 hash。
- M：只在隔离 worktree 完成兼容 Adapter、加固与测试；不得修改已批准 AC 或验收计划。
- V：独立执行 WEXEC-VIEW full Gate、Playwright、性能和对抗测试，Evidence 绑定当前 Plan/HEAD。
- R：仅在 V PASS 后复核全部 AC、provenance、截图和 Evidence hash；R 不替 V 运行测试。
- 双 PASS 只形成 Candidate；视觉 Review、Heavy 接受和 Delivery 仍按当前 revision 分别受控。

## 工作范围

### 包含

- 旧 State History、Ledger、Harness、Gate、Review、Evidence 和 Delivery Adapter；
- exact/derived/unknown provenance 与 diagnostics 完整校验；
- 当前仓库 `.spec-loop` 和至少一个历史 Dogfood Project 的真实重建；
- 200 Task × 200 event 性能 Gate与增量刷新基准；
- 截断/重排/篡改、symlink/path traversal、XSS、Secret canary、异常 HTTP 方法对抗；
- 桌面/窄屏真实浏览器最终路径、截图与人工视觉验收；
- Project 级后台 view 生命周期与 `view start/status/open/stop`；
- Task、批次和 Harness 交互式启动后的幂等自动打开与可点击 URL；
- FEAT-009、DES-009、PROD-001 与架构事实回写。

### 不包含

- Phase 4 Scheduler/Controller 或多 Task 自动并发的实现；
- Portfolio 跨项目聚合；
- 远程访问和外部平台嵌入；
- 自动修复被篡改的权威历史。

## 实施要求

1. 旧数据只能按已有语义标记 exact/derived/unknown，不使用 mtime 作为用户可见耗时。
2. Dogfood 报告必须列出可重建比例、精确耗时覆盖率、未知区间和全部 diagnostics，不能只给页面截图。
3. 最终候选必须使用 `scope_kind: wave`、`coverage: full` 的 Heavy Gate，覆盖 Phase 1–3 回归和 FEAT-009 新增测试；数据库保持 `persistent`。
4. 最终人工验收必须绑定当前 revision、桌面/窄屏截图和 FEAT-009 的关键 AC。
5. 后台 view marker 必须校验 Project realpath、进程身份、loopback URL 和健康状态；禁止误杀 PID 复用后的无关进程，浏览器失败不得阻断任务状态变更。

## 验收标准

- [ ] AC-1：当前仓库和至少一个历史 Dogfood Project 在删除 cache 后均可重建；已知 Gate 时长精确，旧状态/Attempt 缺失时长明确显示 unknown。
- [ ] AC-2：200×200 fixture 冷重建不超过 2 秒，追加单事件后的增量投影和页面可见时间不超过 500 毫秒。
- [ ] AC-3：事件损坏、事实冲突、非法路径、XSS 和 Secret canary 全部 fail closed 或安全降级，无误导性绿色结论。
- [ ] AC-4：桌面与窄屏四条核心浏览器路径全部通过，用户完成当前 revision 的视觉 Review 和 Heavy 人工确认。
- [ ] AC-5：删除 UI cache/snapshot 不影响 Task、Harness、Evidence、Review 或 Delivery，重建后的 canonical snapshot 等价。
- [ ] AC-6：Phase 1–3 全量回归与 FEAT-009 全部 Gate 在最终候选通过；独立 V 确认可重建性和事实源边界，独立 R 复核 AC 覆盖与 Evidence 链，双 PASS 后才形成 Candidate。
- [ ] AC-7：交互终端启动 Task/批次/Harness 时 5 秒内复用或启动唯一 Project view、打印并默认打开 URL；重复启动、僵尸 marker、端口冲突、CI、`--no-view` 和浏览器不可用路径均确定且不阻断任务。
- [ ] AC-8：顶部当前工作优先来自最新未闭合执行步骤；多个 Task 并发时全部可见，旧 working 状态或较新的 Task State 时间不得覆盖实际运行中的 Harness/活动步骤。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1、AC-5 | 自托管与历史 Dogfood 删除重建 | 兼容、等价且未知值诚实展示 |
| AC-2 | 固定规模 benchmark Gate | 冷建与增量满足门限 |
| AC-3 | 安全/恢复对抗套件 | fail closed，无泄漏和误导状态 |
| AC-4 | Playwright + REVIEW-1 + Heavy 人工确认 | 功能和视觉均通过 |
| AC-6 | WEXEC-VIEW full Heavy Harness + 独立 Verifier | 全量 PASS |
| AC-7 | CLI 集成测试 + 子进程/PID/端口故障注入 | 生命周期幂等、安全且入口始终可发现 |
| AC-8 | 多 Task 事件投影测试 + Quant 真实 Dogfood | 当前工作与实际未闭合步骤一致，并发不丢失 |

## 验证范围

- 本 Task 为最终 Heavy 工单，使用 `scope_kind: wave`、`wave_id: WEXEC-VIEW`、`coverage: full`。
- 数据库使用 `persistent`/fixtures，不创建或删除容器。
- 覆盖 Phase 1–3 既有回归、FEAT-009 全部测试、真实 Project Dogfood、安全与性能。

## 人工效果验收

- 是否需要：是；声明 `REVIEW-1` 覆盖 AC-1、AC-4。
- 验收范围：当前工作可辨识度、历史耗时可比较性、unknown/derived 诚实表达、错误态、桌面与窄屏整体信息密度。
- 证据要求：最终 revision 的当前 Project 和历史 Project 截图，桌面与窄屏均包含。

## Web 功能验证

- 是否需要：是；声明 `execution-view-heavy-e2e` Playwright Gate 并覆盖 AC-1、AC-4、AC-5。
- 功能路径：真实重建、当前步骤、历史比较、失败详情、Evidence 定位、cache 删除重建和窄屏交互。

## 交付记录

- 完成日期：非 Heavy 前置实现、性能/真实项目/浏览器定向检查、交互启动和并行当前工作投影已完成，待其余 AC 与正式 Heavy 验收
- 变更文件/交付物：后台 `view-control start/status/open/stop` 生命周期；隔离工作树 `spec-loop/task-029` 的 `e4d8670` 增加归档事件增量校验、投影/Task 状态缓存、200×200 性能与真实项目审计脚本，以及四条真实项目浏览器检查；交互终端启动 Round/Harness/受管波次时自动复用本地 view；顶部当前工作优先选择最新未闭合步骤，并列出其他并行 Task；未归属波次的当前 Task 现在可定位并展开详情；首次全量回归 11 个失败已修复并重新全量通过；正式受管 Heavy 报告仍待执行
- 关键实现与决策：marker 绑定 Project realpath、PID 启动身份、loopback URL 与健康状态；重复 start 复用，陈旧 marker fail closed
- 与原设计的差异：无
- 遗留风险：全量质量套件、200×200 定向基准、三个真实 Project 重建、四条页面加载及当前 Task 详情路径、失败步骤/Evidence 定位、浏览器缓存删除重建、启动/端口冲突、并行当前工作、XSS、符号链接、旧 Gate 路径越界和旧 Attempt 密钥样本检查已通过；正式受管 `WEXEC-VIEW` full Gate、独立 V/R 与人工 Heavy/视觉决定尚未完成。用户已要求不再逐张确认截图；不得把该要求记作 `REVIEW-1` 已批准。
- 正式验收准备：已生成 [v2 Contract 草案](../../.spec-loop/output/TASK-029-contract-draft.json) 与 [WEXEC-VIEW full Gate 草案](../../.spec-loop/output/TASK-029-GATES-draft.md)，覆盖 AC-1～8、7 个 Gate、`persistent/fixtures`，含重复两次的对抗 mutation Gate 与真实 Chrome 截图 Gate。Contract 输入的 SHA-256 为 `c59bd30bbbb9df52be6c258b5c2eba797be23e2f5e0b45ba633e039880788c65`；草案已通过当前 schema 解析，尚未获得精确 hash 人工批准，也未作为正式 Gate Plan 生效。TASK-028 未交付前不得启动本 Task 的受管执行。

## 验证证据

| 日期 | 验证人 | 环境 | 结果 | 证据/输出 |
|---|---|---|---|---|
| 尚未实施 | 未指定 | WEXEC-VIEW Heavy Gate | 待验证 | 尚无 Evidence |
| 2026-09-04 | Codex/M（快速反馈） | Node 22，本地定向测试 | 部分实现通过，非 Heavy Evidence | 新增 `view-control start/status/open/stop`；后台 marker 绑定 Project realpath、PID 启动身份、loopback URL 与健康状态；重复 start 复用，stop 安全校验；execution-view 15/15 通过 |
| 2026-09-30 | Codex/M（全量技术回归） | 隔离候选 `e4d8670`，Node 23 | 构建、连接器契约与 319/319 单测通过；首次全量 308/319，修复 11 项后第二轮全通过；非正式受管 Heavy Evidence | [首次全量记录](../../.spec-loop/output/TASK-029-full-regression-4464a5a.log)、[11 项定向复验](../../.spec-loop/output/TASK-029-repair-fast.tap)、[波次定向复验](../../.spec-loop/output/TASK-029-repair-wave.tap)、[最终全量记录](../../.spec-loop/output/TASK-029-full-regression-e4d8670.log) |
| 2026-09-30 | Codex/M（性能与真实数据） | 本仓库、Quant、海工 Project，候选 `e4d8670` | 200×200 性能门槛及三项目受管 Task 100% 重建通过，未知耗时和全部诊断列出；非正式受管 Heavy Evidence | [性能记录](../../.spec-loop/output/TASK-029-perf-e4d8670.json)：归档 2 段、冷重建 1310ms、增量投影 280ms、HTTP 可见 306ms；[Dogfood 报告](../../.spec-loop/output/TASK-029-dogfood-e4d8670.json)：13/13、17/17、68/68；海工诊断 51 条，固定时刻重复重建一致 |
| 2026-09-30 | Codex/M（浏览器/对抗） | 本仓库与 Quant，Chrome 154，候选 `e4d8670` | 桌面 1440px 与窄屏 390px 四条页面加载、定位当前及展开详情路径通过，无页面错误或横向溢出；失败步骤与 Evidence、浏览器缓存删除重建、恶意工程名、符号链接、旧 Gate 路径越界和旧 Attempt 密钥样本通过；非正式视觉/Heavy Evidence | [浏览器报告](../../.spec-loop/output/TASK-029-browser-e4d8670.json) 含八张截图及 SHA256；[Playwright 回归](../../.spec-loop/output/TASK-029-browser-regression-e4d8670.log) 2/2 |
| 2026-09-30 | Codex/P（正式计划准备） | 隔离候选 `e4d8670` | 8 项 AC、7 个 full Gate 的草案通过 v2 Contract 与 Gate schema 解析；未批准，非正式 Evidence | [Contract 草案](../../.spec-loop/output/TASK-029-contract-draft.json) 输入哈希 `c59bd30bbbb9df52be6c258b5c2eba797be23e2f5e0b45ba633e039880788c65`；[Gate 草案](../../.spec-loop/output/TASK-029-GATES-draft.md) |
| 2026-09-30 | Codex/M（定向修复） | 隔离候选 `91f6d25`，Node 23 | 大快照压缩保留当前和并行 Task 的 running/waiting 步骤；`node --test test/execution-view.test.mjs` 29/29、等待态补充用例 1/1 与 `npm run build` 通过；完整套件和正式 Gate 尚未重绑 | `2a9e57a` 修复压缩，`91f6d25` 补充等待态覆盖；未产生正式 Evidence |
| 2026-09-30 | Codex/M（第一轮完整技术测试） | 隔离候选 `91f6d25`，Node 23、Chrome 154 | 七类 Gate 草案均完成技术运行：构建/契约/Node 319/319、Playwright 2/2、对抗 5/5×2、生命周期 3/3、200×200 基准、三项目重建和四条浏览器路径均通过；不代替受管 Heavy/V/R | [第一轮测试记录](../05-delivery/2026-09-30-Phase4-第一轮技术测试记录.md)与[332 个逐用例结果](../05-delivery/2026-09-30-Phase4-第一轮逐用例结果.json) |

## 关闭检查

- [ ] 验收标准全部通过
- [ ] 测试/检查结果已记录
- [ ] 设计差异已记录
- [ ] 上游实际结果已更新
- [ ] 已从两个看板移除

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-08-12 | 创建 Heavy 工单草案 | 用真实旧项目和全量 Gate 证明可重建、准确与安全 |
| 2026-08-20 | 加入启动即看与后台 view 生命周期 | Quant Dogfood 中需要另开命令和查找随机端口，查看路径不够直接 |
| 2026-08-20 | 加入未闭合步骤优先的当前工作选择 | Quant TASK-005 Harness 运行时顶部误显示 TASK-007，暴露 lifecycle 时间排序缺陷 |
| 2026-09-04 | 批准并对齐 P/M/V/R v2 Heavy | 作为 TASK-027/028 v1 兼容收口后的组合验收，使用独立 V/R 与 Candidate Gate |
| 2026-09-04 | 开始非 Heavy 前置实现 | 补后台 view 生命周期与故障恢复；未运行 full Gate、性能 Gate、Playwright 或 Heavy 验收 |
| 2026-09-30 | 定向性能修复与真实项目重建 | 将事件按 Task 分组、减少投影压缩重复排序、校验归档追加前缀并缓存状态；200×200 门槛及三个 Project 的审计报告均通过，保持最终 Heavy 待办 |
| 2026-09-30 | 接入交互式启动即看 | Round、Harness、Acceptance 角色与受管波次启动复用唯一 Project view；CI/非 TTY/`--no-view` 跳过，浏览器失败只报警；启动 5 秒上界、端口占用恢复定向通过 |
| 2026-09-30 | 当前工作改以活动步骤为准 | 多 Task 并行时最新未闭合步骤优先于 Task State 时间；旧活动步骤即使被 20 条较新注释挤出普通列表仍保留，顶部列出其他并行 Task |
| 2026-09-30 | 修复未归属波次 Task 的定位与展开 | 真实工程浏览器检查发现“定位当前”被默认 H15 回退覆盖，且从任务行无法展开详情；改由未归属 Task 的独立详情路径渲染 |
| 2026-09-30 | 修复完整技术回归的 11 个失败 | 保持 Provider 沙箱写边界；修正旧夹具写入目标、只读报告的依赖诊断、Gate 计划错误优先级和可删除 Evidence 链接检查；第二轮 319/319 通过 |
