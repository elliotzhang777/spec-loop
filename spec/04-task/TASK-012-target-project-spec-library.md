# TASK-012：目标工程规格库

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 最后更新：2026-09-04
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-004

## 目标

确保每个纳入 Agent Loop 的目标工程在自身 Git 仓库维护同构的系统规格库，而不是只在 Spec-Loop 控制目录保存任务材料。

## 验收标准

- [x] AC-1：`project init` 默认创建目标工程 `spec/` 四层目录、Roadmap、说明和看板。
- [x] AC-2：`project spec-init` 只补充缺失文件，不覆盖已有规格。
- [x] AC-3：`project spec-check` 对缺失文件和空内容失败。
- [x] AC-4：Project metadata 明确记录 `spec_root`。
- [x] AC-5：自动化测试覆盖创建、失败校验和恢复补建。
- [x] AC-6：批准 Proposal 创建 Task 时，同步生成目标工程真实 Task 规格并写入 AC 和控制任务引用。
- [x] AC-7：显式 `--adopt-existing` 可接管 ID、标题和 AC 与 Proposal 完全一致的草稿 Task，并拒绝覆盖非草稿、已绑定或内容不一致的规格。

## 交付记录

- 实现：`src/project.ts` 的目标规格库 scaffold/check，以及 CLI `project spec-init/spec-check`。
- 验证：`test/project.test.mjs`。
- 约束：同名目标 Task 默认拒绝覆盖；只有显式接管且草稿内容与批准内容一致时才建立控制绑定。交付后实际结果回写将在 Project write-back 增强中继续收紧。

## 正式验证结论

- TASK-013 的 Phase 3 最终 Heavy 覆盖规格库创建、补建、严格检查、Proposal 批准后 Task 同步和接管边界；后续 TASK-017、018、020 又完成模板事实源、目录治理与分工程模板加固。
- WPHASE3 full Harness、67 项回归、独立 Verifier 和用户 Heavy 验收已通过，完整覆盖本工单 AC-1～AC-7。
- 正式证据见[阶段三交付报告](../05-delivery/阶段三交付报告.md)和 [TASK-013](TASK-013-phase3-hardening-acceptance.md)。

## 关闭检查

- [x] 验收标准全部通过
- [x] Phase 3 最终 Heavy Evidence 已覆盖
- [x] 后续模板与目录加固已交付
- [x] 已从临时看板移除

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 将历史“待验证”纠正为“已完成” | TASK-013 已正式覆盖本工单全部 AC，原状态未随 Phase 3 收口同步 |
