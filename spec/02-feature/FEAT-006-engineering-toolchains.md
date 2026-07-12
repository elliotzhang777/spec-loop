# FEAT-006：工程 Toolchain 与原生证据

- 状态：部分完成（T1 已交付，T2/T3 待后续阶段）
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 所属阶段：Phase 3（T1）/ Phase 4（T2/T3）/ Phase 5（资产治理）

## 用户价值

作为不同技术栈的开发者，我希望 spec-loop 能按项目类型构建、测试并收集原生 Evidence，而不要求我手工整理命令输出。

## 行为说明

Toolchain 从 T0 外部 Evidence 演进到 T1 通用命令、T2 平台预设和 T3 原生结果解析。初始目标包括 Spring Boot、Xcode/iOS 和微信小程序。

## 业务规则

1. Toolchain 不能决定 AC passed 或 delivered。
2. 命令使用参数数组、环境 allowlist、超时和 artifact capture。
3. Evidence 绑定真实 Git HEAD 和当前 Round。
4. Xcode 每任务使用独立 DerivedData；Simulator 是可租赁资源。
5. 签名、发布、支付、登录和生产动作默认 Heavy 且人工门禁。

## 验收标准

- AC-1：通用命令执行器生成可验证 Evidence。
- AC-2：Spring Boot preset 识别 Maven/Gradle 并收集测试结果。
- AC-3：Xcode preset 支持 build/test、DerivedData 和 XCResult。
- AC-4：小程序 preset 收集 npm/构建/人工设备证据。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-006 工程 Toolchain 适配](../03-design/DES-006-engineering-toolchain-adapters.md) | 草稿 |
| Task | T1 已由 [TASK-009](../04-task/TASK-009-git-worktree-gate.md)交付；T2/T3 待 Phase 4 稳定后拆分 | 部分完成 |

## 实际交付

- 已实现行为：T0 外部 Evidence 与 T1 通用命令 Gate；命令受 cwd、超时、环境限制约束，并生成绑定 Git HEAD 的 artifact。
- 未实现行为：Spring Boot、Xcode/iOS、微信小程序等 T2/T3 平台预设与原生结果解析。
- 验证结论：T1 已通过自动化测试和两个真实 Git Project Dogfood；T2/T3 待后续阶段验证。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | Toolchain 分配到最终 Phase 3–5 | 最终 Roadmap定稿 | - |
