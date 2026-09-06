# TASK-033：P/M/V/R 执行事件与观察面接入

- 状态：进行中
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-09-06
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

- [ ] AC-1：每个 v2 阶段和路由均有可配对、可验证、可重建的事件事实。
- [ ] AC-2：页面明确区分 P/M/V/R、v1/v2、当前执行与用户浏览状态。
- [ ] AC-3：Contract/Plan/HEAD/Evidence/Conflict/Candidate 的引用和新鲜度诊断准确。
- [ ] AC-4：多个 invocation 和多 Task 并发不会丢失、覆盖或错误合并。
- [ ] AC-5：桌面和窄屏真实浏览器路径通过，状态不只依赖颜色表达。
- [ ] AC-6：页面保持 loopback-only、GET/HEAD-only，恶意事件和 Secret canary 不泄漏。
- [ ] AC-7：cancelled 关闭全部活动步骤并冻结 Task/波次计时；无 Event Log 的历史 Task 不生成 Workflow；Snapshot 对步骤、文本、引用和诊断实施有界投影。

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
- 尚缺真实桌面/窄屏浏览器路径和视觉 Review；当前 in-app Browser 没有可用浏览器实例，因此不能标记待验证或完成。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 创建并批准 | 为最新版架构补齐 v2 运行事实与观察面之间的显式桥梁 |
| 2026-09-04 | 开始实现 | 角色事件、v2 Snapshot 投影和 UI 协议标识已接入；等待真实浏览器反馈 |
| 2026-09-06 | 故障加固 | 修复 cancelled/历史 Task 投影并加入 Snapshot 大小边界与 EPIPE 处理 |
