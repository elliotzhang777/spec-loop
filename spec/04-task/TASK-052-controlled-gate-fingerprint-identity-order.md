# TASK-052：受管 Gate 失败指纹丢失数字身份并受 TAP 顺序影响

- 状态：已完成
- 风险等级：standard
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-10-01
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 关联工单：TASK-049 AC-1、AC-2
- 来源轮次：第六轮，TASK-049 候选 `d6007cd38dbfa5e40180e819fcd97ccfc27e5822`
- 工单类型：独立 R 发现的失败路由缺陷

## 问题与证据

TASK-049 的定向 Gate 与独立 V PASS 后，独立 R `INV-TASK-049-R-1ba73ed1-b70a-4b74-a2c7-82cb30cb16cd` 发现两个同一根因的失败指纹缺口。`src/acceptance-loop.ts` 的 `failureFingerprint` 对完整错误消息执行 `/\d+/g` 替换，因此 `parameterized path 1` 与 `parameterized path 2` 被合并；`describeControlledGateFailures` 以 TAP 输出顺序连接失败名，导致同一组失败逆序后指纹不同。原 R 结果和复核报告在 `.spec-loop/output/TASK-049-acceptance-v2/invocations/INV-TASK-049-R-1ba73ed1-b70a-4b74-a2c7-82cb30cb16cd/evidence/`，受管摄入已将 TASK-049 退回 M。

## 工作范围与验收标准

- [x] AC-1：不同失败测试名中的数字身份被保留，不同用例不会错误合并为重复失败。
- [x] AC-2：同一组失败测试的 TAP 顺序、编号和耗时变化不改变失败指纹。
- [x] AC-3：TASK-049 新候选的受管定向 Gate、独立 V/R 和当前集成候选完整质量套件通过；旧 R FAIL 保留。

修复归入 TASK-049 同一受管返工与新 HEAD；不另建重复的实施分支。定向复现已在 `test/acceptance-loop.test.mjs` 增补，下一轮按新候选重新绑定证据。

## 收口证据

修复归入 TASK-049 候选 `b587ed0058b706c8ad035e5e421939738d96ce72`，受管定向 Gate 2/2 与独立 V/R PASS；原 R FAIL、审计记录和新 Candidate 均保留。第六轮集成 HEAD `5c3a6d0a124c09602301a749296a70faa3af1a91` 的质量套件 325/326，唯一失败是独立的 TASK-053 夹具前置问题；第七轮新 HEAD `c45dea66cd8a707b3c36d48b9a2980d340001650` 的完整质量套件 326/326 PASS，日志 `.spec-loop/output/ROUND7-c45dea6-quality-full.txt` SHA-256 为 `e6986a16971a4fc1a2e8a4fdb6a9a2c4d6e452151da9747a0016a5bcabe80533`。实现和批准设计一致，无视觉验收范围。
