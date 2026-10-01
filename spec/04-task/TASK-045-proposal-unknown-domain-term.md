# TASK-045：Proposal 不得把耗时精度 unknown 当作未填写

- 状态：已完成
- 风险等级：light
- Spec-Loop Task：.spec-loop/tasks/task-045
- Proposal：PROP-15
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-30
- 最后更新：2026-09-30
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 历史关联工单：TASK-032（已完成；已从受管 Contract 依赖清单移除）
- 任务等级：Light
- 协议版本：P/M/V/R v2
- 来源轮次：2026-09-30 第二轮续执行
- 工单类型：缺陷

## 目标

允许有实质内容的 Contract、验收标准和 Proposal 正确描述旧数据的 `unknown` 精度及被拒绝的占位词，同时继续拒绝真正未填写的占位值。

## 工作范围

- 修正 `src/files.ts` 的实质内容检查，区分单独占位值与句中的领域术语；Proposal 逐字段校验，不把整个 JSON 当成单一字段。
- 加入 TASK-029 Contract 的 v2 Proposal 复现，以及纯占位值仍被拒绝的回归。
- 保留 `TODO`、`TBD`、`待填写`、模板尖括号和双花括号等未完成内容的拒绝边界。
- 不改写 TASK-029 的 AC、Contract 语义或 Gate 门槛。

## 验收标准

- [x] AC-1：包含耗时精度 `unknown` 的完整 AC/Proposal 可正常创建并保持原文。
- [x] AC-2：仅含 `unknown` 或 `未知` 的字段，以及显式 TODO/TBD/待填写等占位内容仍被拒绝。
- [x] AC-3：TASK-029 的原定 Contract 经 P 准备后通过 Proposal 入口，Target Task 文本不需为绕过校验而改写。

## 缺陷记录

- 发现轮次与候选：2026-09-30 第二轮续执行；主分支 `f98fd43`，最终隔离技术候选 `e5ddd81`。
- 关联用例：TASK-029 AC-1 与 P Contract 创建；新增 `T045-AC-1～3`。
- 复现：使用 `.spec-loop/output/TASK-029-contract-draft.json` 调用 `triage propose`，返回 `proposal: empty or placeholder content`；Contract 的 AC-1 和 UC-1 以 `unknown` 描述合法的缺失耗时精度。
- 期望与实际：完整规格文本应被接受，单独占位词才拒绝；实际 `assertSubstantive(JSON.stringify(proposal))` 对 JSON 内任何 `unknown` 命中全局占位正则，无法进入 P；同一根因还会把描述 TODO/TBD 拒绝规则的完整 AC 误判为占位。
- 影响：阻断 TASK-029 Heavy 受管 Contract；不能改写 AC 绕过，否则验收语义会漂移。严重度 P1。
- 下一轮验证：定向内容校验/Proposal 测试通过后，纳入整个未完成规格库的完整适用矩阵复测；新的稳定候选重新绑定技术与正式证据。

## 验证范围

- `scope_kind: task`、`coverage: targeted`、`persistent/fixtures`；无视觉或 Web Gate。
- 隔离修复提交 `d904742`、`0d081f1` 调整占位检查和 Proposal 逐字段验证，保留单独 `unknown`/`未知`、TODO/TBD/待填写及显式待办指令的拒绝；`npm run build` 与 `test/project.test.mjs` 7/7 通过。原 TASK-029 Contract 已通过 P Proposal；TASK-045 的原文 AC 也以 `PROP-15`/`APR-17` 通过 P 并绑定受管 Task。最终 `7f5cacd` 受管 targeted Gate 2/2 PASS，Harness Report hash `bbbcf3cd81edf57fbfa5f4158bbb202c40e42a008654298fa0aaf43aa9bc387f`；全量 321/321 与第三轮技术台账均已复测。Contract 版本修订及独立 V/R 仍待办。

## Contract 数据修订历史

`PROP-15`/`APR-17` 批准的 v2 Contract 将已完成的历史 TASK-032 列入 `depends_on`，但 TASK-032 没有受管 `.spec-loop/tasks/` 记录。旧 report-only 因此标记 TASK-045 为 `unknown v2 contract dependency`、`missing_data=1`；这是本工单 P 数据错误，不计作新产品缺陷。TASK-050 通过受管版本 2 修订移除该历史依赖，保留旧批准哈希和审计记录；修订后的 report-only `missing_data=0`。

原[版本 2 修订草案](../../.spec-loop/output/TASK-045-contract-v2-dependency-correction-draft.json)通过 Acceptance Contract 输入 schema；与版本 1 输入相比，仅将 `version` 从 1 改为 2，并移除受管 `depends_on` 中的已完成历史 TASK-032。原 AC、Use Case、工具、断言和预算逐字段不变。草案文件 SHA-256：`087d145ff94a3a9d18abbf966ab7b2a8f54dd2c91c932455245366ba905e64e5`。实际受管修订见 `.spec-loop/output/TASK-045-contract-correction-applied.json`。

## 收口证据

候选 `8ed8b89ae339ea1edde3eada46d115d7c5d97611` 通过受管 targeted Gate 2/2、`test/project.test.mjs` 9/9 及独立 V/R；`.spec-loop/tasks/task-045/ACCEPTANCE_RUN.json` 已生成 Candidate。TASK-029 原 Contract 和完整 `unknown` 描述保持原文；裸占位值、内嵌 TODO/TBD/待填写、单复数 `placeholder` 指令均在 Proposal 入口被拒绝。历次独立 V 发现的边界问题归入 TASK-051，失败记录保留。实现和批准设计一致，无视觉验收范围。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-30 | 建立第二轮新缺陷 | TASK-029 Heavy Contract 的合法耗时精度术语被误判为占位内容 |
