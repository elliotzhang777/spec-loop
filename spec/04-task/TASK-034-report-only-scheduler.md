# TASK-034：Report-only Scheduler

- 状态：待验证
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-09-04
- 所属设计：[DES-005](../03-design/DES-005-scheduling-worktree-coordination.md)
- 所属特性：[FEAT-005](../02-feature/FEAT-005-scheduling-isolation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-032
- 任务等级：Standard
- 协议版本：P/M/V/R v2
- 所属批次：P4-B3

## 目标

以只报告、不创建 Task、不执行 Agent 的方式周期扫描 Project，输出可重建的候选、重复项、风险、成本和 Ready/blocked 原因，为自动调度积累可靠基线。

## 工作范围

包括幂等扫描、cursor、报告、建议去重、风险/成本指标、误报和采纳统计；不包含 Task 创建、代码修改、M/V/R 启动或任何外部写入。

## 验收标准

- [ ] AC-1：重复扫描同一事实产生 canonical 等价报告且不创建或修改 Task。
- [ ] AC-2：每项建议包含来源、去重键、依赖、风险、预估成本和可解释的 Ready/blocked 原因。
- [ ] AC-3：可统计建议量、重复率、误报、采纳率、扫描耗时和缺失数据。
- [ ] AC-4：Pause、过期 cursor、损坏输入和并发扫描均 fail closed 或安全恢复。
- [ ] AC-5：报告不包含 Secret、Prompt 原文或跨 Project 私有数据。

## P/M/V/R 职责与验证范围

P 冻结报告契约；M 实现；V 用多 Project Fixture 验证幂等、安全和指标；R 复核 Evidence。使用 `scope_kind: task`、`coverage: targeted`、`persistent/fixtures`。

## 实现与快速反馈记录

- 新增 `scheduler init/report/status/pause/resume`，只写 Scheduler 配置、cursor 和报告，不创建或改写 Task。
- 报告按项目/任务事实生成稳定 dedupe key、依赖、风险、成本、Ready/blocked 原因与 canonical hash。
- 指标覆盖建议量、重复率、采纳率、误报和缺失数据；反馈使用独立 `SCHEDULER_FEEDBACK.json`。
- 并发 scan、Pause、损坏/跨 Project cursor 均 fail closed；过期 cursor 自动执行 full scan。
- 2026-09-04 快速反馈：编译通过；`test/report-scheduler.test.mjs` 1/1 通过。尚未执行正式独立 V/R。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 创建并批准 | 遵循路线图“先报告后执行”，不直接开启自动修改 |
| 2026-09-04 | 实现候选进入待验证 | canonical report、cursor、质量指标与只报告边界完成 |
