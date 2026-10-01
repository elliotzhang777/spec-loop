# TASK-033：P/M/V/R 执行事件与观察面接入

- 状态：已完成
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-09-30
- 所属设计：[DES-009](../03-design/DES-009-execution-visualization.md)
- 所属特性：[FEAT-009](../02-feature/FEAT-009-execution-visualization.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-027、TASK-028、TASK-032
- 任务等级：Standard
- 协议版本：P/M/V/R v2
- 所属批次：P4-B2

## 目标

让事件协议、Snapshot 和只读观察面原生展示 v2 Contract、M/V/R invocation、失败路由、预算、Conflict、Review Inbox 和 Candidate，不把 v1 Task State 当成 v2 事实。

## 工作范围

### 包含

- v2 P/M/V/R 事件类型、配对、hash chain 和 provenance；
- Snapshot 的 contract/plan/HEAD、角色、阶段、预算、冲突和 Candidate 投影；
- v1/v2 同屏但显式区分的兼容展示；
- 多 invocation、失败路由与返工轮次的 DAG/时间线；
- Conflict/Review Inbox 只读入口和诊断；
- 增量刷新、安全降级及浏览器路径。

### 不包含

- 从页面修改运行状态或作出批准；
- 自动调度、外部 Connector 写入；
- 为缺失事件的旧运行伪造角色或耗时。

## 验收标准

- [x] AC-1：每个 v2 阶段和路由均有可配对、可验证、可重建的事件事实。
- [x] AC-2：页面明确区分 P/M/V/R、v1/v2、当前执行与用户浏览状态。
- [x] AC-3：Contract/Plan/HEAD/Evidence/Conflict/Candidate 的引用和新鲜度诊断准确。
- [x] AC-4：多个 invocation 和多 Task 并发不会丢失、覆盖或错误合并。
- [x] AC-5：桌面和窄屏真实浏览器路径通过，状态不只依赖颜色表达。
- [x] AC-6：页面保持 loopback-only、GET/HEAD-only，恶意事件和 Secret canary 不泄漏。
- [x] AC-7：cancelled 关闭全部活动步骤并冻结 Task/波次计时；无 Event Log 的历史 Task 不生成 Workflow；Snapshot 对步骤、文本、引用和诊断实施有界投影。

## 验证计划

定向事件/Snapshot/HTTP 测试和真实 Playwright；视觉 Review 绑定稳定候选后另行请求。

## 验证范围

- `scope_kind: task`，`coverage: targeted`，数据库 `persistent/fixtures`。

## 当前实现与快速反馈

- 已增加 `role.m/role.v/role.r` 和 v2 plan/route/candidate 配对事件，Acceptance Run ID 可作为 provenance。
- Snapshot 已投影协议、阶段、Contract/Plan/HEAD、预算、invocation、Evidence、Conflict、Candidate 及新鲜度诊断。
- UI 已显式标记 v1/v2，并以 P、M、V、R 角色标签展示事件和候选链。
- cancelled 已成为终态投影，阶段不再继续显示 running；历史完成但无事件的 Task 明示“耗时未记录”，不绘制虚构 DAG。
- Dashboard 每 Task 最多返回最近 100 个步骤，每步摘要 500 字、引用 10 个，项目诊断 200 条；完整 Event Log 仍保留原始事实。
- 2026-09-04 快速反馈：`npm run build` 通过；受管角色投影用例通过；`test/execution-view.test.mjs` 15/15 通过。
- `4366ed8` 独立 V 发现 Candidate 后旧角色仍显示“等待摄入”、v1 State 时间早于 v2 Candidate 使 wall=0；均已在 `ed8d0fa` 修复。独立 [V](../../.spec-loop/output/TASK-033-V-ed8d0fa.json) 与 [R](../../.spec-loop/output/TASK-033-R-ed8d0fa.json) 对 AC-1～7 技术项 PASS；真实 Chrome 桌面/390px、事件链、并发和证据哈希通过。
- 当前集成候选 `a53bbba` 上，独立 [V](../../.spec-loop/output/TASK-033-V-a53bbba.json) 与 [R](../../.spec-loop/output/TASK-033-R-a53bbba.json) 重新核验 AC-1～7 技术项 PASS；相关实现与 `ed8d0fa` 逐字节一致，当前构建、关键回归和 Chrome 1440/390px 浏览器路径通过。截图及哈希见 `.spec-loop/output/TASK-033-browser-a53bbba.json`。
- 共用页眉修复后的 `03cb2aa` 已在 v2 Candidate fixture 的桌面/390px Chrome 路径通过，工程选择框与连接状态无重叠，截图及哈希见 `.spec-loop/output/TASK-033-browser-03cb2aa.json`；该 HEAD 的独立技术复核仍待完成。
- 共用平板布局修复后的 `6eef0ca` 已重新通过 v2 Candidate fixture 的桌面/390px Chrome 路径；截图及哈希见 `.spec-loop/output/TASK-033-browser-6eef0ca.json`。当前 HEAD 的技术 V/R 复核分别见 `.spec-loop/output/TASK-033-V-6eef0ca.json`、`TASK-033-R-6eef0ca.json`；旧 V/R 后仅有 CSS 布局和浏览器断言变化，关键回归 4/4，当前截图哈希和状态边界均通过。
- `6eef0ca` 的桌面与 390px 截图由 Codex 依用户 2026-09-30「继续完成，不要找我确认了」的委托完成视觉判断，布局、角色标识和状态可读性接受；[REVIEW-1 委托记录](../../.spec-loop/output/TASK-033-visual-6eef0ca.json)绑定两张截图、技术 V/R 文件及 SHA-256。记录不声称用户亲自审图。AC-1～7 在此 revision 完成，TASK-029/037 的 Heavy 仍分别验收。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 创建并批准 | 为最新版架构补齐 v2 运行事实与观察面之间的显式桥梁 |
| 2026-09-04 | 开始实现 | 角色事件、v2 Snapshot 投影和 UI 协议标识已接入；等待真实浏览器反馈 |
| 2026-09-06 | 故障加固 | 修复 cancelled/历史 Task 投影并加入 Snapshot 大小边界与 EPIPE 处理 |
| 2026-09-29 | 修复 Candidate 终态角色与耗时投影并完成独立技术 V/R | 旧角色不再冒充实时进度，生命周期终点取 Candidate 事件；人工视觉仍待当前 revision 决定 |
| 2026-09-29 | 在集成候选重绑技术 V/R 与浏览器证据 | `a53bbba` 上 AC-1～7 技术 PASS；桌面/390px 截图已绑定当前 HEAD，人工视觉仍待独立决定 |
| 2026-09-29 | 重绑窄屏页眉浏览器截图 | `03cb2aa` 桌面/390px Chrome 路径通过；旧 HEAD 独立 V/R 保留为历史证据，新 HEAD 独立复核和人工视觉待办 |
| 2026-09-30 | 重绑平板布局后的浏览器截图 | `6eef0ca` 的桌面/390px Chrome 路径通过；独立复核与人工视觉仍待完成 |
| 2026-09-30 | 完成当前 HEAD 技术复核与委托视觉判断 | `6eef0ca` 技术 V/R、桌面/窄屏浏览器与截图哈希通过，Codex 按用户委托接受视觉；TASK-033 关闭 |
