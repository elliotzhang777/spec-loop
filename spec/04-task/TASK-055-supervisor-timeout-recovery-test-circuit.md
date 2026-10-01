# TASK-055：Supervisor 超时恢复用例在持续失败后错误期待自动恢复

- 状态：已完成
- 风险等级：standard
- Spec-Loop Task：.spec-loop/tasks/task-055
- Proposal：PROP-24
- 协议版本：P/M/V/R v2
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-10-01
- 最后更新：2026-10-01
- 所属设计：[DES-005](../03-design/DES-005-scheduling-worktree-coordination.md)
- 所属特性：[FEAT-005](../02-feature/FEAT-005-scheduling-isolation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 来源轮次：第八轮，TASK-029 当前候选正式 Heavy V
- 关联工单：TASK-029 AC-6、TASK-037 AC-3/7
- 来源候选：`03f68a07a513eb9163853923c83131f72659d229`

## 缺陷与复现

TASK-029 当前 HEAD 的七项正式 Gate 中，`execution-view-heavy-full` 执行 `npm run quality:standard`，326 项 Node 用例 325 PASS、1 FAIL；其余六项 Gate PASS。失败用例是 `test/scheduler-control.test.mjs` 的“Supervisor verifies a timed-out watchdog has exited before it starts another cycle”。用例主动持有事件锁直到 watchdog 超时，但使用生产默认的连续失败熔断门槛 3；在全量套件负载下，释放锁前已累计三次失败，Supervisor 正确打开 circuit。用例随后仍等待自动恢复并断言 `healthy=true`，实际为 `reason=circuit_open`。受管 V 失败判定和 `CONFLICT-TASK-029-1790825843789` 保留该失败；旧原始完整日志及七项 Gate 最新汇总被重跑覆盖，不能再作为历史原始证据，见 [TASK-056](TASK-056-gate-evidence-immutable-runs.md)；不能以其他六项 PASS 冒充 Heavy PASS。

期望：该用例在验证超时 worker 确实退出、下一轮安全恢复时，不把连续失败熔断路径混入恢复断言；另有独立用例维持 circuit 门禁验证。实际：测试条件允许触发 circuit，却要求无需复位自行恢复。根因是测试隔离条件不足，完整套件的时序可触发确定性的熔断分支。

## 验收标准

- [x] AC-1：超时恢复用例在全量套件负载下稳定证明旧 worker 已退出，释放锁后 Supervisor 健康恢复；该用例不会意外进入持续失败熔断分支。
- [x] AC-2：现有连续失败熔断、显式复位及 worker 停止门禁测试继续通过，生产默认门槛与逻辑保持原规格。
- [x] AC-3：定向 Scheduler 测试及下一轮完整适用 Gate 通过，TASK-029 当前候选重新完成独立 V/R。

## 验证计划

在 `test/scheduler-control.test.mjs` 中为恢复用例设置足以隔离 intentional timeout 的熔断上限，并验证释放锁后的健康状态；定向运行 Scheduler 测试，再随 TASK-029 正式 Heavy Gate 完整回归。独立 circuit 用例保持原默认配置。

## 交付记录

- 当前状态：受管 `PROP-24`/`APR-26` 已批准；隔离修复 `897480f` 的构建通过、两个关键场景 2/2 PASS、Scheduler 全套 8/8 PASS。TASK-029 新受管候选 `3be7123` 已通过完整 Heavy Gate 7/7、Node 326/326 和独立 V/R；本单 clean HEAD `1c097f3` 的定向 Gate 2/2、Scheduler 8/8、独立 V/R 均 PASS，形成 `.spec-loop/output/TASK-055-acceptance-v2/CANDIDATE.json`。
- 设计差异：仅修正测试场景，不改变生产 Supervisor 熔断行为。
