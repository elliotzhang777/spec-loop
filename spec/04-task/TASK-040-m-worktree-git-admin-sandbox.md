# TASK-040：M 工作树 Git 管理目录沙箱授权

- 状态：待验证
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-19
- 最后更新：2026-09-19
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-032 实现候选
- 任务等级：Light
- 协议版本：P/M/V/R v2
- 所属批次：目标工程接入修复

## 目标

让受管 M Provider 在 linked worktree 中拥有完成 `git add` 和 `git commit` 所需的最小 Git 管理目录写权限，避免实现完成后因主仓库 `.git/worktrees/<task>` 不在工作区沙箱内而无法形成候选提交。

## 工作范围

### 包含

- 运行 M 时解析候选工作树的 Git worktree 管理目录和 common Git 目录；
- 将两个目录作为 Codex `workspace-write` 的附加可写根传入；
- 目录必须真实存在且为普通目录，结果去重；
- V/R 的只读候选行为和 Evidence 写入边界保持不变。

### 不包含

- 扩大到仓库父目录或任意文件系统路径；
- 改变 P/M/V/R 状态机、Acceptance hash 或 Gate 结果；
- 正式 V/R、完整 Gate、merge、push 或发布。

## 验收标准

- [x] AC-1：M 的 Codex 参数同时包含 linked-worktree Git 管理目录和 common Git 目录的 `--add-dir`。
- [x] AC-2：Evidence 根仍被单独放行，重复目录不会产生重复参数。
- [x] AC-3：V/R 现有 `--skip-git-repo-check`、只读候选快照和 Evidence 目录行为不变。
- [x] AC-4：TypeScript 构建与 acceptance-loop 定向测试通过。

## 验证计划

| 验收标准 | 验证方法 | 预期结果 |
|---|---|---|
| AC-1～AC-3 | `test/acceptance-loop.test.mjs` 参数回归 | M 获得最小 Git 管理目录写根，V/R 行为不变 |
| AC-4 | `npm run build`、定向 Node test | 构建和定向回归通过 |

## 验证范围

- `scope_kind: task`，`coverage: targeted`。
- 本轮只做实现与快速反馈；正式独立 V/R 需另获当前稳定候选授权。

## 交付记录

- 完成日期：2026-09-19，实现候选待正式验证。
- 变更文件/交付物：`src/role-orchestrator.ts`、`test/acceptance-loop.test.mjs`。
- 快速反馈：`npm run build` 通过；`node --test test/acceptance-loop.test.mjs` 18/18 通过。
- 关键实现：只接受主仓库 `.git` 本身或其后代目录，拒绝符号链接、缺失目录和逃逸路径；M 参数去重追加 Git worktree/common 管理根，V/R 不变。
- 遗留风险：正式独立 V/R 尚未授权；海工 TASK-001 的额外 M 重试仍受其获批预算约束。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-19 | 创建并开始实施 | 海工 TASK-001 M 在 linked worktree 中完成实现后无法创建主仓库 Git `index.lock` |
| 2026-09-19 | 实现候选进入待验证 | 构建与 18 项 acceptance-loop 定向回归通过，等待独立正式 V/R |
