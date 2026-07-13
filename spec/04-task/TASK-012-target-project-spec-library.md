# TASK-012：目标工程规格库

- 状态：待验证
- 优先级：P0
- 负责人：Codex
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
