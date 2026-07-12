# 规格库使用说明

本目录是 spec-loop 产品方向、行为、技术方案、执行工单和验证结果的唯一规格事实源。

这是 Spec-Loop 产品自身的规格库。每个被管理的目标工程还必须在其仓库内维护同构的 `spec/` 规格库，保存该工程的 Product、Feature、Design 和 Task；`.spec-loop/` 只保存闭环控制状态和证据。

## 目录结构

```text
spec/
├── roadmap.md
├── pending-board.md
├── verification-board.md
├── 01-product/
│   ├── _template.md
│   └── PROD-001-local-spec-loop.md
├── 02-feature/
│   ├── _template.md
│   └── FEAT-*.md
├── 03-design/
│   ├── _template.md
│   └── DES-*.md
└── 04-task/
    ├── _template.md
    └── TASK-*.md
```

## 追踪链

```text
roadmap.md
  → PROD-001 本地规格闭环产品
      → FEAT-001 文件驱动生命周期
          → DES-001 文件契约、状态机与验收
              → TASK-001 Phase 1 实现
      → FEAT-002 运行账本与 Guard
          → DES-002 Ledger、预算与原子恢复
              → TASK-002 Phase 2 实现
      → FEAT-003 Project Loop 与 Agent 执行（Phase 3）
      → FEAT-004～006 受控自动化、调度隔离与 Toolchain（Phase 4）
      → FEAT-007 Portfolio、能力资产与持续优化（Phase 5）
```

## 当前事实

- Phase 1–3：已完成并有自动化测试和真实 Dogfood Evidence。
- 当前任务治理：Light、Standard、Heavy。
- 当前自动化：A1，可通过 Provider Harness 在独立 worktree 单步执行，默认 Codex；不包含后台调度。
- 当前 Toolchain：T1，支持受控通用命令 Gate 和绑定 Git HEAD 的 Evidence。
- 当前 Delivery 权限：D0，只生成本地 Delivery。
- Phase 3：已正式 Delivery；Phase 4–5 仍为草案，尚未批准实施，阶段定义以 `roadmap.md` 为准。

## 两个看板

- [待完成任务看板](pending-board.md)：只放已批准、尚未完成的工单。
- [验证看板](verification-board.md)：只放实现完成、等待独立验证的工单。

看板是临时视图。Phase 1–3 已关闭，因此当前看板为空；永久历史保存在 `04-task/TASK-001`～`TASK-012` 和上游规格中。

## 使用流程

1. 在 Roadmap 确认阶段方向。
2. 从 Product 拆出用户可感知 Feature。
3. 用 Design 定义技术方案和验证策略。
4. 拆成可独立交付的 Task，经批准后加入待完成看板。
5. 实现后进入验证看板。
6. 验证通过，把结果写回 Task、Design、Feature、Product，再清空看板条目。
