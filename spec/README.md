# 规格库使用说明

本目录是 spec-loop 产品方向、行为、技术方案、执行工单和验证结果的唯一规格事实源。

这是 Spec-Loop 产品自身的规格库。每个被管理的目标工程还必须在其仓库内维护同构的 `spec/` 规格库，保存该工程的 Product、Feature、Design 和 Task；`.spec-loop/` 只保存闭环控制状态和证据。

## 目录结构

```text
spec/
├── roadmap.md
├── architecture.md
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
├── 04-task/
│   ├── _template.md
│   └── TASK-*.md
└── 05-delivery/
    ├── 阶段一至二交付报告.md
    └── 阶段三交付报告（已撤回）.md
```

## 工程目录存放规范

项目相关的产品说明、架构设计、开发说明、实施计划、工程工单、验证结论和阶段交付报告必须放在 `spec/` 规格库中，不得散落在项目根目录。

```text
spec-loop/
├── README.md              工程入口、安装和使用说明
├── AGENT.md               AI 与人工协作约定
├── package.json           Node.js 工程配置
├── package-lock.json      依赖锁文件
├── tsconfig.json          TypeScript 构建配置
├── src/                   产品源码
├── test/                  自动化、对抗和恢复测试
├── artifacts/             测试与审查原始证据
├── dogfood/               真实闭环运行样例及其 Evidence
└── spec/                  全部项目规格、设计、开发和交付说明
```

| 内容 | 权威位置 |
|---|---|
| 产品目标、用户、范围和成功指标 | `spec/01-product/` |
| 用户可感知能力和业务验收标准 | `spec/02-feature/` |
| 架构、接口、数据、安全、恢复和技术取舍 | `spec/03-design/` |
| 开发任务、实施要求、验证计划和交付记录 | `spec/04-task/` |
| 阶段交付报告和撤回记录 | `spec/05-delivery/` |
| 当前执行队列 | `spec/pending-board.md` |
| 当前验证队列 | `spec/verification-board.md` |
| 原始测试或审查输出 | `artifacts/`，并由对应 Task 引用 |
| 真实运行目录和 Evidence | `dogfood/`，并由对应 Task或交付报告引用 |

根目录 `README.md` 只承担项目入口和使用说明，不作为产品设计、开发计划或阶段交付结论的事实源。新增设计或开发说明时，必须先确定所属 Product、Feature、Design 或 Task，再写入对应目录。

## 交付归档

- [阶段一至二交付报告](05-delivery/阶段一至二交付报告.md)
- [阶段三交付报告（已撤回）](05-delivery/阶段三交付报告（已撤回）.md)

## 追踪链

```text
roadmap.md
  → PROD-001 本地规格闭环产品
      → architecture.md 系统总体架构
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

技术架构总入口：[Spec-Loop 系统总体架构](architecture.md)。

## 当前事实

- Phase 1–2：已完成。Phase 3 核心原型和加固实现已具备，正式独立验收待完成。
- 当前任务治理：Light、Standard、Heavy。
- 当前自动化：A1，可通过 Provider Harness 在独立 worktree 单步执行，默认 Codex；不包含后台调度。
- 当前 Toolchain：T1，支持受控通用命令 Gate 和绑定 Git HEAD 的 Evidence。
- 当前 Delivery 权限：D0，只生成本地 Delivery。
- Phase 3：原正式 Delivery 结论已撤回，TASK-013 正在等待独立 Heavy 验收；Phase 4–5 仍为草案。

## 两个看板

- [待完成任务看板](pending-board.md)：只放已批准、尚未完成的工单。
- [验证看板](verification-board.md)：只放实现完成、等待独立验证的工单。

看板是临时视图。Phase 1–2 已关闭；Phase 3 加固实现位于 TASK-013，当前进入验证队列。

## 使用流程

1. 在 Roadmap 确认阶段方向。
2. 从 Product 拆出用户可感知 Feature。
3. 用 Design 定义技术方案和验证策略。
4. 拆成可独立交付的 Task，经批准后加入待完成看板。
5. 实现后进入验证看板。
6. 验证通过，把结果写回 Task、Design、Feature、Product，再清空看板条目。
