# TASK-029：执行可视化兼容重建、Dogfood 与加固验收

- 状态：草稿
- 优先级：P1
- 负责人：待定
- 创建日期：2026-08-12
- 最后更新：2026-08-12
- 所属设计：[DES-009](../03-design/DES-009-execution-visualization.md)
- 所属特性：[FEAT-009](../02-feature/FEAT-009-execution-visualization.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-027、TASK-028

## 目标

证明执行可视化可以在旧 Project、当前 spec-loop 自托管 Project 和大规模 fixture 上安全重建，并用最终 Heavy 验收关闭兼容性、性能、隐私、故障恢复和真实使用风险。

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
- [ ] AC-6：Phase 1–3 全量回归与 FEAT-009 全部 Gate 在最终候选通过，独立 Verifier 确认可重建性和事实源边界。
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

- 完成日期：尚未实施
- 变更文件/交付物：兼容 Adapter、性能/安全 Gate、Dogfood 与 Heavy 报告（待实施）
- 关键实现与决策：按 DES-009 实施，差异在交付时记录
- 与原设计的差异：无
- 遗留风险：无

## 验证证据

| 日期 | 验证人 | 环境 | 结果 | 证据/输出 |
|---|---|---|---|---|
| 尚未实施 | 未指定 | WEXEC-VIEW Heavy Gate | 待验证 | 尚无 Evidence |

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
