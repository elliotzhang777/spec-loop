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
    ├── 阶段三交付报告.md
    ├── 阶段三交付报告（已撤回）.md
    ├── phase-1-2/
    │   ├── evidence/
    │   └── dogfood/
    ├── phase-3/
    │   └── evidence/
    └── phase-3-withdrawn/
        └── dogfood/
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
├── assets/                运行时随包资产
├── products/              目标工程最终成品的本机统一出口
└── spec/                  全部项目规格、设计、开发和交付说明
```

以下目录由本地构建或 Spec-Loop 运行产生，已由 Git 忽略，不属于权威工程结构，包括 `dist/`、`node_modules/`、`.spec-loop/`、`.spec-loop-tx/`、`.spec-loop-cross-tx/` 和 `.spec-loop-cross-tx-data/`。最终可安装/可分发成品统一发布到本机 `products/{project-slug}/{version}/`，其元数据格式由 `products/README.md` 定义。

| 内容 | 权威位置 |
|---|---|
| 产品目标、用户、范围和成功指标 | `spec/01-product/` |
| 用户可感知能力和业务验收标准 | `spec/02-feature/` |
| 架构、接口、数据、安全、恢复和技术取舍 | `spec/03-design/` |
| 开发任务、实施要求、验证计划和交付记录 | `spec/04-task/` |
| 阶段交付报告和撤回记录 | `spec/05-delivery/` |
| 当前规格库轮次的全部未完成工单 | `spec/pending-board.md` |
| 当前轮次的待验证子集 | `spec/verification-board.md` |
| 当前运行时模板资产 | `assets/target-spec/` |
| 目标工程最终安装包/分发包 | `products/{project-slug}/{version}/`（本机，不提交 Git） |
| Phase 1–2 原始证据和 Dogfood | `spec/05-delivery/phase-1-2/` |
| Phase 3 正式 Evidence 摘要 | `spec/05-delivery/phase-3/` |
| 已撤回 Phase 3 原型 Dogfood | `spec/05-delivery/phase-3-withdrawn/` |

根目录 `README.md` 只承担项目入口和使用说明，不作为产品设计、开发计划或阶段交付结论的事实源。新增设计或开发说明时，必须先确定所属 Product、Feature、Design 或 Task，再写入对应目录。

## 交付归档

- [阶段一至二交付报告](05-delivery/阶段一至二交付报告.md)
- [阶段三交付报告](05-delivery/阶段三交付报告.md)
- [阶段三交付报告（已撤回）](05-delivery/阶段三交付报告（已撤回）.md)
- [Phase 1–2 证据与 Dogfood](05-delivery/phase-1-2/README.md)
- [Phase 3 正式 Evidence 摘要](05-delivery/phase-3/README.md)
- [已撤回 Phase 3 原型现场](05-delivery/phase-3-withdrawn/README.md)

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
      → FEAT-008 飞书进度通知与确认连接器（Phase 4）
      → FEAT-007 Portfolio、能力资产与持续优化（Phase 5）
```

技术架构总入口：[Spec-Loop 系统总体架构](architecture.md)。

## 当前事实

- Phase 1–3：已完成。Phase 3 正式 Heavy 验收于 2026-08-03 通过。
- 当前任务治理：Light、Standard、Heavy。
- 当前自动化：Phase 4 的受控调度、角色执行和本地 Review 控制面已实现；最终跨能力 Heavy 与阶段验收仍待完成。现有 Scheduler Wave 不是跨完整规格库的一键轮次控制器。
- 当前 Toolchain：受控命令、Playwright 与 Spring Gate Planner 已有实现；最终能力以各 Task 和 Heavy Evidence 为准。
- Web 验证：显式 Playwright Gate 与绑定 revision 的人工视觉 Review 分别留证，前者不代替后者。
- 当前 Delivery 权限：D0，只生成本地 Delivery。
- Phase 3：加固版本已由独立 Verifier 和用户 Heavy 验收通过，正式 Delivery 已重新签署；Phase 4 在进行中，Phase 5 尚未启动。

## 规格库轮次与两个看板

- [待完成任务看板](pending-board.md)：从全部 Task 规格盘点未完成工单，包含待验证和被阻塞项；未获批准不等于获准实施。
- [验证看板](verification-board.md)：同一轮中具备验证条件的子集，记录 Gate、V/R 和人工决定。

2026-09-30 起，用户级节奏是“全库盘点 → 可执行项按依赖推进 → 冻结候选 → 集中测试与独立 V/R → 集中裁决 → 下一轮”。看板是 Task 状态的可重建视图；当前 Phase 4 尚有 5 个未完成工单，原波次只是内部执行和证据机制。

当前轮次的 [48 条 AC 测试矩阵](05-delivery/2026-09-30-Phase4-完整轮次测试矩阵.md)逐项记录结果，并汇总正式 Gate、浏览器路径、回归与人工决定。集中测试结束后，确认的代码失败按根因创建缺陷 Task；下一轮将这些缺陷和原未完成 Task 一起推进、冻结新候选并重测完整适用矩阵。

## 使用流程

1. 在 Roadmap 确认阶段方向。
2. 从 Product 拆出用户可感知 Feature。
3. 用 Design 定义技术方案和验证策略。
4. 拆成可独立交付的 Task；每轮将所有未完成 Task 盘点到待完成看板，只有批准且具备条件的 Task 才实施。
5. 按依赖推进本轮可执行项，集成冻结候选后按完整测试矩阵运行全部适用用例、Gate 和独立 V/R；待验证 Task 同时进入验证看板。
6. 汇总失败用例并建立缺陷 Task，集中裁决视觉、Heavy、阶段及外部动作；下一轮一并修复缺陷和原未完成项，再重测完整矩阵。已完成项写回 Task、Design、Feature、Product，再从看板移除。
