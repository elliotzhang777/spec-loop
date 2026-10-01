# TASK-053：v1 报告型调度夹具保留未填写 Round

- 状态：已完成
- 风险等级：light
- Spec-Loop Task：.spec-loop/tasks/task-053
- Proposal：PROP-21
- 协议版本：P/M/V/R v2
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-10-01
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 来源轮次：第六轮，集成 HEAD `5c3a6d0a124c09602301a749296a70faa3af1a91`
- 工单类型：全量验证发现的测试夹具缺陷

## 问题与证据

第六轮完整 `quality:standard` 在 326 个 Node 用例中 325 PASS、1 FAIL，原始日志 `.spec-loop/output/ROUND6-5c3a6d0-quality-full.txt`。唯一失败为 `test/report-scheduler.test.mjs` 的 `report-only keeps nonterminal v1 tasks visible without calling them dispatch ready`：夹具执行 `round` 后直接 `verify`，Round 模板的 Work/Changes/Outcome 仍为 `TODO`，新版 `assertSubstantive` 因此正确返回 `Round 1 body: empty or placeholder content`。真实 v1 工作流要求验证前填写 Round 内容；测试夹具未满足该前置条件。原失败不能算作报告型调度产品缺陷，也不能用旧 HEAD 的全量 PASS 覆盖。

## 工作范围与验收标准

- [x] AC-1：v1 report-only fixture fills the Round before verification without weakening placeholder validation.
- [x] AC-2：The v1 lifecycle regression passes and keeps nonterminal v1 tasks visible but not dispatch ready.
- [x] AC-3：The new integrated HEAD passes the complete quality suite; the prior failed report and new hashes remain archived.

修复仅调整 `test/report-scheduler.test.mjs` 的前置夹具；受管候选 `8df95df78e7f50d5e62a39d73e0c78b5fca93842` 的 targeted Gate 2/2、独立 V/R 均 PASS，形成 Candidate。它与集成 HEAD `c45dea66cd8a707b3c36d48b9a2980d340001650` 的 Git tree 相同，后者 `quality:standard` 326/326 PASS。原 `.spec-loop/output/ROUND6-5c3a6d0-quality-full.txt` 的 325/326 FAIL 和新 `.spec-loop/output/ROUND7-c45dea6-quality-full.txt` 的 PASS 均保留并绑定 SHA-256；详细受管记录见 `.spec-loop/tasks/task-053/ACCEPTANCE_RUN.json`。产品校验与调度逻辑未改，测试夹具与批准范围一致，无视觉验收范围。
