# TASK-039：目标规格 Task 文件名解析兼容

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-19
- 最后更新：2026-09-29
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-031 实现候选
- 任务等级：Light
- 协议版本：P/M/V/R v2
- 所属批次：目标工程接入修复

## 目标

让 `triage create-task --adopt-existing` 能按目标规格库既有命名约定采用 `TASK-001-engineering-foundation.md` 这类带名称文件，避免错误创建第二份同 ID 规格或要求目标工程破坏自身文件名规范。

## 工作范围

### 包含

- 解析精确 `TASK-001.md` 与单一 `TASK-001-*.md` 候选；
- 将解析后的真实文件路径写入运行 Task 的 `target_spec`；
- 同一 ID 存在多个候选时 fail closed；
- 保持无既有规格时创建精确 `TASK-001.md` 的兼容行为。

### 不包含

- 批量重命名目标工程规格；
- 改变 Proposal、Approval、P 契约或跨根事务语义；
- 完整 Gate、merge、push 或发布；独立定向 V/R 已在批准范围内完成。

## 验收标准

- [x] AC-1：单一 `TASK-001-engineering-foundation.md` 这类带名称草稿可被 `--adopt-existing` 原位采用，运行 Task 的 `target_spec` 指向该文件。
- [x] AC-2：同一目录存在两个匹配同一 Task ID 的规格时拒绝采用或创建，不覆盖任何文件。
- [x] AC-3：不存在既有规格时仍创建 `TASK-001.md`，已有精确 `TASK-001.md` 的兼容行为不变。
- [x] AC-4：定向 Project/Target Spec 测试与 TypeScript 构建通过，无目标工程重复规格。

## 验证计划

| 验收标准 | 验证方法 | 预期结果 |
|---|---|---|
| AC-1～AC-3 | `test/project.test.mjs` 定向 CLI 回归 | 命名解析确定、歧义 fail closed、旧行为不变 |
| AC-4 | `npm run build`、`test/project.test.mjs`、`test/target-spec.test.mjs` | 构建与定向测试通过 |

## 验证范围

- `scope_kind: task`，`coverage: targeted`。
- 当前执行约定允许已批准 Task 内连续完成定向 V/R；候选变化只重新绑定证据，不重复申请授权。

## 交付记录

- 完成日期：2026-09-29；候选 `eca847d` 独立 Light V/R 双 PASS。
- 变更文件/交付物：`src/project.ts`、`test/project.test.mjs`。
- 快速反馈：`npm run build` 通过；`node --test test/project.test.mjs test/target-spec.test.mjs` 18/18 通过。
- 关键实现：精确文件和单一带名称文件共用确定性解析；多个同 ID 候选 fail closed；运行 Task 记录解析后的真实相对路径。
- 正式证据：`.spec-loop/output/TASK-039-{V,R}-eca847d.json`。构建与 Project/Target Spec 定向 18/18 通过；独立 fixture 证明双候选不覆盖任一文件、精确文件仍可采用。海工 live `backend/spec/05-task/` 的 TASK-001 仅一份，运行 SPEC 指向带名称真实路径，业务仓库保持干净。
- 遗留风险：本工单仅覆盖目标 Task 文件解析兼容；完整 Heavy、merge、push 和发布仍按各自任务执行。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-19 | 创建并开始实施 | 海工项目采用标准命名的 TASK-001 草稿时发现现有解析只识别 `TASK-001.md` |
| 2026-09-19 | 实现候选进入待验证 | 构建与 18 项定向回归通过，等待独立正式 V/R |
| 2026-09-29 | 完成独立 Light V/R 并关闭工单 | AC-1～4 全通过，海工 live 目录无同 ID 重复规格 |
