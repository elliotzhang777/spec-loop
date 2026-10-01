# TASK-047：快速退出进程身份测试的固定等待竞态

- 状态：已完成
- 风险等级：light
- Spec-Loop Task：.spec-loop/tasks/task-047
- Proposal：PROP-17
- 协议版本：P/M/V/R v2
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-30
- 最后更新：2026-09-30
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-046 已完成
- 任务等级：Light
- 来源轮次：2026-09-30 第四轮，TASK-029 当前候选 `36c631a9895105b296563deb4eadad246bfa4fd3`
- 工单类型：验证基础设施缺陷

## 目标

让“子进程先退出、身份探测后完成”用例由真实事件顺序决定，不再依赖固定 300 毫秒等待。保留对仍存活但无法识别身份的进程 fail closed 检查。

## 发现与复现

- TASK-029 受管 `WEXEC-VIEW` full Gate 的 `quality:standard` 在当前 HEAD 运行 321 个 Node 用例：320 PASS、1 FAIL；其余六个 Heavy Gate 均 PASS。
- 唯一失败为 `test/managed-process.test.mjs:41` 的 `a child that exits before its identity probe completes remains a valid fast result`；断言期望 code 0，实际 125。原测试让 `identifyProcess` 固定等待 300ms 后返回 null。在全套并发负载下，子进程可能在这 300ms 后才报告退出，此时产品逻辑按设计拒绝仍存活且身份不明的进程。
- 原始报告：`.spec-loop/output/ROUND4-36c631a-heavy-failed-archive/TASK-029-gate-execution-view-heavy-full.txt`，`not ok 216`；受管 V Run 回到 `m_working`，不将 6/7 Gate 误记为完整 PASS。

## 工作范围

- 只改用例的时序同步与必要测试辅助逻辑，让身份探测在已观察到子进程真实退出后完成。
- 保留 `managed-process` 生产代码、安全边界、质量脚本与全部测试文件；不跳过或放宽用例。
- 在新集成 HEAD 先跑定向回归，再重跑 TASK-029 已批准的七组 Heavy Gate，并保留失败/成功报告与 HEAD、Plan hash。

## 验收标准

- [x] AC-1：快速退出用例通过实际 `exit` 事件控制探测顺序，在全量负载下不再因固定 300ms 时钟产生误失败。
- [x] AC-2：身份不明且仍存活的子进程仍返回 125 并被清理；快速退出的真实 code 0 保持成功。
- [x] AC-3：新集成 HEAD 的全量 `quality:standard` 与 TASK-029 七组受管 Heavy Gate 完整通过；Node 用例数不减少，历史 FAIL 原文保留。

## 验证范围

- `scope_kind: task`、`coverage: targeted`、`persistent/fixtures`，覆盖 `test/managed-process.test.mjs`；完整组合回归归 TASK-029 Heavy。
- 当前为第四轮失败转单；修复进入第五轮。若仍有失败，保留 FAIL 并继续按根因建单或返工，不把隔离定向 PASS 代替全量结果。

## 第五轮实施证据

- TASK-029 集成修复 HEAD `4f7fb6e1c2c8d27fadb2ae8a0ca85a0c93e7514f`：测试等待真实 `exit` 事件后让身份探测返回 null，生产代码不变；本机 `test/managed-process.test.mjs` 5/5 PASS。
- 本工单独立受管 M HEAD `70688bb2f8eb2e7c46383b2937e5cc82184d6d55` 与上述修复文件内容相同，已编译 targeted Plan；后续 V/R 必须结合新集成 HEAD 的完整 Heavy 结果，不提前宣称 AC-3 PASS。

## 收口证据

独立候选 `70688bb2f8eb2e7c46383b2937e5cc82184d6d55` 的受管 targeted Gate 2/2、独立 V/R 均 PASS；集成 HEAD `246cecdc6ee1f0d2862a85e12600aecb5a652d84` 的 TASK-029 七组 Heavy Gate 和 Node 322/322 均 PASS。两 HEAD 的相关测试改动一致，历史 `not ok 216` 保留。修复仅涉及测试时序，没有改变生产进程身份安全逻辑；见 `.spec-loop/tasks/task-047/ACCEPTANCE_RUN.json` 和 `.spec-loop/output/TASK-029-gates.json`。
