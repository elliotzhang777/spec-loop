# TASK-063：已合入候选被误判为 baseline_drift

- 状态：待验证
- 风险等级：standard
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-10-02
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)、[DES-005](../03-design/DES-005-scheduling-worktree-coordination.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)、[FEAT-005](../02-feature/FEAT-005-scheduling-isolation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 来源：Phase 4 已验收候选合入后的 Phase 5 进入条件只读核对
- 关联验收：TASK-037 AC-9

## 缺陷与复现

TASK-029 候选 `3be7123` 和 TASK-037 候选 `2ebee82` 均已获用户最终 Heavy 验收；后者已快进合入 `main`，随后仅有规格记录提交。2026-10-02 在 `14b7a69` 上执行只读 `scheduler control run-ready` 预览，`candidate_recovery` 却将两者和其他已合入候选标为 `baseline_drift`，建议回到 M 重跑 V/R。原始预览见 `.spec-loop/output/PHASE5-READINESS-2026-10-02-root-preview.json`。

根因：`reconcileCandidateBaseline` 只检测默认分支是否为候选祖先；当候选已成为默认分支祖先时，落入泛化的漂移分支。显式执行波次将对这些已合入候选调用 `--apply`，可能无必要地破坏原 Candidate 状态及 Evidence 绑定。真实分叉的候选仍必须保持原有 `baseline_drift` 保护。

## 验收标准

- [ ] AC-1：默认分支等于或包含候选 HEAD 时，预览明确显示已合入状态，保留原 Candidate/Evidence，不建议回 M。
- [ ] AC-2：已合入候选的 `--apply` 不改变受管 Run；显式波次只对真正分叉的候选执行 baseline recovery。
- [ ] AC-3：未合入但默认分支可快进到候选时仍为 `ready_ff`；真实分叉仍为 `baseline_drift`，现有读-only 与重排保护不退化。
- [ ] AC-4：定向控制面测试、构建、当前工程只读预览和独立 V/R 通过；不重复 Phase 4 已批准的 full Heavy Gate。

## 验证范围

`coverage: targeted`，只修改候选基线分类和直接调用边界；定向执行 `test/acceptance-loop.test.mjs` 与必要的 Scheduler 测试。新发现的产品失败按根因单独建工单；飞书、Phase 5 Portfolio 和自动 merge/push/deploy 不在本工单范围。

## 实施与定向证据

在独立工作树修正 `reconcileCandidateBaseline`：候选 HEAD 等于或先于默认分支时分类为 `already_integrated`，`--apply` 为只读无操作；可快进和真实分叉分别保留 `ready_ff`、`baseline_drift`。`npm run build` PASS；`node --test test/acceptance-loop.test.mjs` 42/42 PASS。使用新 CLI 对当前工程只读预览，TASK-029/037 均为 `already_integrated`，`applied=false`，原始结果 `.spec-loop/output/TASK063-preview-after-fix.json`。第一次独立 V 指出 Git `merge-base` 运行错误被误当成非祖先，AC-2 FAIL；原始记录 `.spec-loop/output/TASK063-independent-V.md`。已改为只把 Git 退出码 1 当作非祖先，其他错误 fail closed；新增同 HEAD 与 Git 退出码 128 注入用例，修复后构建和两条相关定向测试 2/2 PASS。第二次独立 V/R 尚待完成。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-10-02 | 建立已合入候选误判缺陷 | 用户要求继续完成，真实只读预览暴露交付后状态对账风险 |
