# TASK-046：全量质量套件并发导致时限用例误失败

- 状态：已完成
- 风险等级：light
- Spec-Loop Task：.spec-loop/tasks/task-046
- Proposal：PROP-16
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-30
- 最后更新：2026-09-30
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：无
- 任务等级：Light
- 协议版本：P/M/V/R v2
- 来源轮次：2026-09-30 第三轮
- 工单类型：验证基础设施缺陷

## 目标

使 `quality:standard` 在受管 Heavy Gate 的本机 Node 22 环境中完整执行全部用例，避免多个高负载测试文件并发时触发固定短时限断言的误失败。

## 工作范围

- 只调整 `package.json` 中质量套件的 Node 测试文件并发度（最终为 2；串行 1 的估算总耗时约 69 分钟，会超过 Gate 60 分钟上限）；保持构建、飞书契约检查和 `test/*.test.mjs` 全量覆盖。
- 以 `a3aa40d` 的失败用例和隔离复验为基线，在新组合 HEAD 重跑同一 `npm run quality:standard` 受管 Heavy Gate。
- 保留生产调度器与进程控制逻辑；恢复测试仍要求已停止旧 Worker、进入 degraded 后重新健康，不通过删除或跳过用例取得 PASS。

## 验收标准

- [x] AC-1：`quality:standard` 仍执行 build、飞书契约检查和全部 `test/*.test.mjs`，无跳过或用例数减少。
- [x] AC-2：此前六个在高并发下失败的进程身份与 Scheduler 时限用例，在新组合候选的全量质量 Gate 中全部 PASS。
- [x] AC-3：新组合候选的受管 `WEXEC-VIEW` full Gate 完整通过，并保留原失败报告、隔离 6/6 复验和新报告的 HEAD/Plan hash 供对比。

## 缺陷记录

- 发现候选：`a3aa40d41c94a3cf44c025dbfe0d8c0950c552ab`；受管 TASK-029 full Gate 报告 `b2d2b5aa54ca3f9911c3c0ff919bc0da7447a43c1e7431b863d11aea54cb6279`。
- 复现：`npm run quality:standard` 使用 `node --test --test-concurrency=4 test/*.test.mjs`。本机 Node 22、目标工作树本地依赖下，全套 321 项为 315 PASS、6 FAIL；其余六个 Heavy Gate 均 PASS。
- 失败用例：`managed-process` 快速退出身份探测 1 项，`scheduler-control` lease/Pause/Kill、波次派发、watchdog 3 项，`scheduler-safety` 旧观察和 Project lease 2 项。详情在 `.spec-loop/output/TASK-029-gate-full-a3aa40d-failed.txt` 的 `not ok 216/274/275/278/284/287`。
- 隔离复验：同一 HEAD 对这六项按 1+3+2 分组定向执行，全部 PASS；并发 2 的三个相关测试文件在 Node 22 下 19/19 PASS；未改动生产代码或断言。因此当前证据指向并发负载引起的时限误失败，不把受管全量 FAIL 改写为 PASS。
- 下一轮验证：新候选 `7f5cacd` 已重新冻结：321/321 和七个 Heavy Gate 全 PASS；逐用例记录保留失败历史和最终报告。

## 验证范围

- `scope_kind: task`、`coverage: targeted`、`persistent/fixtures`；正式缺陷 Gate 验证脚本和关键时限用例；最终 full 回归在 TASK-029 Heavy 中执行。

- 已批准的 TASK-046 targeted Contract 工具使用并发 1 检查三个相关测试文件；最终质量脚本为并发 2。两者不可混称同一 Gate，实际并发 2 的 Node 22 定向 19/19 结果与完整 `WEXEC-VIEW` Gate 分别记录。

## 当前技术证据

- 隔离修复分支 `spec-loop/task-046`：`6890f01` 首次将并发 4 调为 1，三个相关文件 19/19 PASS；估算 321 项串行用例耗时约 69 分钟，超出 Gate 60 分钟上限，因此该候选完整 Gate 主动中止并保留 FAIL。
- 修订提交 `bf73e07` 将脚本设为并发 2；Node 22 下三个相关文件 19/19 PASS，保留全部测试文件。集成候选 `bf73e07a260c09c411daaef9e5057cfca9d304ef` 的受管 full Gate 321 项中 320 PASS、1 FAIL；唯一失败是 Supervisor 恢复等待 10 秒上限。该上限不是产品 SLA，测试需允许受控 Worker 完成退出确认和下一周期，仍必须最终健康；旧 FAIL 报告另存。最终 `7f5cacd` 受管 Heavy 7/7 PASS，Report hash `7d0e778253a68dee8588fdb62afbdf0eb9c9f2d4a6871edd12589a545da4f10f`；本工单 targeted 2/2 PASS，Report hash `7eac28dc21d774373d54d5841d81b26e1a7e661019cb1b8ae7f8b5fcf5399c80`。第四轮正式独立 V/R 已完成，详见下方当前 HEAD 证据。

第四轮独立 M/V/R 已完成：受管 M 提交 `9e955652c1eaa4826f5ee1ecf2d927e3ace46fd6`，与此前完整 Heavy PASS 的 `7f5cacd` Git tree 相同；当前 HEAD 定向 Gate 构建与 19 个相关测试均 PASS，独立 V/R 覆盖 AC-1～3 并生成 Candidate。当前定向 Harness Report hash `023e205328c952dcf768c1cddeea7bd1c5d28b1120ae7fc061cecfb92494ca0d`；完整 Heavy 证据仍严格绑定历史 `7f5cacd`，本轮新集成 HEAD 需在 TASK-029 再跑完整 Gate。

第四轮 `36c631a` 集成回归出现新的残余测试竞态：固定 300ms 的快速退出身份探测在 321 项全量负载下出现 `not ok 216`，全量质量 320/321。原 TASK-046 Candidate 和历史 7/7 PASS 不被改写；当前回归失败按同一根因转 [TASK-047](TASK-047-fast-exit-identity-test-race.md)，第五轮修复并重测。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-30 | 建立第三轮验证基础设施缺陷 | 全量并发 4 下六个短时限用例 FAIL，隔离同 HEAD 6/6 PASS |
