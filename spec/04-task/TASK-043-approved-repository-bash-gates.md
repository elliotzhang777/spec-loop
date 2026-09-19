# TASK-043：允许 P 契约精确绑定的仓库 Bash Gate

- 状态：待验证
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-19
- 最后更新：2026-09-19
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-030、TASK-042 实现候选
- 任务等级：Light
- 协议版本：P/M/V/R v2
- 所属批次：目标工程接入修复

## 目标

在继续拒绝任意 Shell 分派的前提下，允许执行由人工批准 P 契约精确绑定、位于候选仓库内且不可逃逸的单一 Bash Gate 脚本。

## 工作范围

### 包含

- 只允许命令形态 `bash <safe-relative-path>.sh`；
- 命令数组必须与当前批准的 `ACCEPTANCE_CONTRACT_V2.md` Tool 完全一致；
- 脚本必须位于候选 worktree 内、为普通非符号链接文件；
- `bash -c`、额外参数、绝对路径、路径逃逸和未批准脚本继续拒绝。

### 不包含

- 允许任意 Shell 命令或解释器内联代码；
- 绕过候选 HEAD、Gate Plan、Provider 或 Evidence 绑定；
- 放宽 Git、发布、提权和 Secret 规则。

## 验收标准

- [x] AC-1：批准 P 契约中精确声明的仓库 Bash 脚本可由 Controlled V 执行。
- [x] AC-2：未批准 Bash、`-c`、额外参数、绝对/逃逸路径和符号链接 fail closed。
- [x] AC-3：现有 Shell/dispatcher hardening 回归保持通过。
- [x] AC-4：TypeScript 构建与 acceptance-loop/hardening 定向测试通过。

## 验证范围

- `scope_kind: task`，`coverage: targeted`。
- 本轮只做实现与快速反馈；目标 Task 的正式 V 授权保持绑定原候选。

## 交付记录

- 完成日期：2026-09-19（实现与快速反馈完成，待独立 V/R）。
- 变更文件/交付物：`src/execution.ts`、`test/acceptance-loop.test.mjs`。
- 快速反馈：`npm run build` 通过；`node --test test/acceptance-loop.test.mjs` 19/19 通过；`node --test test/hardening.test.mjs` 11/11 通过。
- 遗留风险：正式独立 V/R 尚未授权；本修复仅作为已获批海工 TASK-001 正式 V 的控制器前置修复。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-19 | 创建并开始实施 | 海工 TASK-001 获批的四个 Bash Gate 被通用 dispatcher 防护拒绝 |
| 2026-09-19 | 实现精确契约绑定、仓库 `scripts/` 路径约束与定向回归，转待验证 | 在不开放任意 Shell 的前提下恢复批准 Gate 的可执行性 |
