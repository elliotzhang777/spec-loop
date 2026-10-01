# TASK-049：受管 Gate 不同失败被合并为重复指纹

- 状态：已完成
- 风险等级：standard
- Spec-Loop Task：.spec-loop/tasks/task-049
- Proposal：PROP-20
- 协议版本：P/M/V/R v2
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-30
- 最后更新：2026-09-30
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 来源轮次：第五轮，TASK-029 HEAD `4f7fb6e1c2c8d27fadb2ae8a0ca85a0c93e7514f`
- 工单类型：失败路由缺陷

## 问题与证据

第四轮受管 V 的唯一失败是 `test/managed-process.test.mjs` 快退出身份测试（`not ok 216`）。第五轮该用例已通过，唯一失败换成 `test/execution-view.test.mjs` 后台视图启动（`not ok 84`）。`runControlledV` 对两次失败均只输出 `one or more controlled Gates failed`、同一 AC-6 和 `implementation_problem`，`failureFingerprint` 因此得到相同值 `29a64a...`。Controller 把不同根因误判为重复失败，提前进入 `waiting_human_review`，冲突 `CONFLICT-TASK-029-1790777556189`。

证据：[第四轮日志](../../.spec-loop/output/ROUND4-36c631a-heavy-failed-archive/TASK-029-gate-execution-view-heavy-full.txt)、[第五轮日志](../../.spec-loop/output/ROUND5-4f7fb6e-heavy-failed-archive/TASK-029-gate-execution-view-heavy-full.txt)和 `.spec-loop/tasks/task-029/ACCEPTANCE_RUN.json`。两个根因各自需要建单和复验，不能把它们合并为同一重复失败。

## 工作范围

- 让受管 Gate 的 V 失败指纹包含稳定的失败用例或错误类别摘要，同时避免时间戳、随机端口、耗时和整份日志哈希造成同一失败每次不同。
- 保留相同失败达到批准次数后的冲突停机、安全预算和 Evidence 绑定。
- 对不同 TAP `not ok`、相同 TAP 失败和没有 TAP 的 Gate 退出错误添加定向回归。

## 验收标准

- [x] AC-1：同一 Gate/AC 下不同失败用例产生不同指纹，不误触发重复失败冲突。
- [x] AC-2：同一失败在不同 HEAD 或非本质日志变化后仍按批准阈值停机。
- [x] AC-3：定向 Controller 回归与完整质量套件通过；已有冲突保留原记录，后续按合法 Review 决议继续。

## 验证范围

定向 `test/acceptance-loop.test.mjs` 和受管 Gate 失败路由；最终完整回归归 TASK-029 Heavy。

## 收口证据

独立 R 首次在 `d6007cd38dbfa5e40180e819fcd97ccfc27e5822` 发现数字测试名误合并与失败顺序敏感，归 [TASK-052](TASK-052-controlled-gate-fingerprint-identity-order.md)；该 FAIL 与原冲突保留。修复候选 `b587ed0058b706c8ad035e5e421939738d96ce72` 的受管定向 build 与回归 Gate 2/2、独立 V/R 均 PASS，并形成 Candidate。回归覆盖同名不同数字、相同失败集合的逆序/编号/耗时变化、Provider 非本质数字变化及第九个失败用例；历史冲突按已审计的 `change_approach` 继续。原集成 HEAD `246cecdc6ee1f0d2862a85e12600aecb5a652d84` 的完整质量套件 322/322 PASS，最终集成 HEAD `5c3a6d0a124c09602301a749296a70faa3af1a91` 的完整轮次结果另行归档。见 `.spec-loop/tasks/task-049/ACCEPTANCE_RUN.json` 与 `.spec-loop/output/TASK-049-gates.json`。修复和批准设计一致，无视觉验收范围。
