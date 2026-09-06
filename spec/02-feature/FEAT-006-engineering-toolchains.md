# FEAT-006：工程 Toolchain 与原生证据

- 状态：进行中
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-09-04
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 所属阶段：Phase 3（T1）/ Phase 4（T2/T3）/ Phase 5（资产治理）

## 用户价值

作为不同技术栈的开发者，我希望 spec-loop 能按项目类型构建、测试并收集原生 Evidence，而不要求我手工整理命令输出。

## 行为说明

Toolchain 从 T0 外部 Evidence 演进到 T1 通用命令、T2 平台预设和 T3 原生结果解析。初始目标包括 Web/Playwright、Spring Boot、Xcode/iOS 和微信小程序。Playwright 先作为 Phase 3 的显式 Web Gate 交付；自动发现、影响分析和其他平台预设仍按 Phase 4 演进。

## 业务规则

1. Toolchain 不能决定 AC passed 或 delivered。
2. 命令使用参数数组、环境 allowlist、超时和 artifact capture。
3. Evidence 绑定真实 Git HEAD 和当前 Round。
4. Xcode 每任务使用独立 DerivedData；Simulator 是可租赁资源。
5. 签名、发布、支付、登录和生产动作默认 Heavy 且人工门禁。
6. Gate Plan 必须声明验证时机、影响范围、选择理由和升级条件；默认选择能覆盖风险的最小充分集合。
7. 快速反馈检查不能冒充正式交付 Evidence；正式 Gate 只对稳定、已提交的最终候选运行。
8. Toolchain 不得因项目历史 Task 较多而机械重放所有 Task Gate；阶段全量回归必须由阶段工单或高影响规则显式要求。
9. Playwright Gate 只能使用目标 worktree 本地安装的 CLI，不允许通过 `npx` 临时联网下载工具；至少一项测试实际通过，零测试、unexpected、flaky、skipped、超时或缺失 JSON 报告均失败。
10. Web Gate 的 JSON、HTML、截图和附件清单必须绑定当前 base/HEAD 并逐文件哈希；声明视觉验收时至少保留一张截图供人工 Review。
11. 业务波次拆分后的 Task 默认只验证自身 AC、改动模块和直接依赖；波次全量回归由最终阶段工单只运行一次。Task Evidence 不得冒充波次整体 Evidence。
12. 分层 Gate Plan 必须声明 `scope_kind`；每个 Gate 必须映射本 Task AC。`wave` 必须绑定 `wave_id` 且只能由 Heavy Task 执行。
13. Light/Standard Task 只能使用 `coverage: targeted`；`coverage: full` 只允许最终 Heavy Task。
14. 普通 Gate 默认复用长期验证数据库，不得反复创建、删除容器或数据卷；一次性数据库仅用于有明确原因的迁移、初始化、升级/回滚或隔离类 Heavy 验证。

## 验收标准

- AC-1：通用命令执行器生成可验证 Evidence。
- AC-2：Spring Boot preset 识别 Maven/Gradle 并收集测试结果。
- AC-3：Xcode preset 支持 build/test、DerivedData 和 XCResult。
- AC-4：小程序 preset 收集 npm/构建/人工设备证据。
- AC-5：Gate Planner 能根据 touched files、依赖、风险和交付时机生成可解释的最小验证集合，并在满足升级条件时扩大范围。
- AC-6：Playwright Web Gate 能证明真实测试数量，收集报告与截图并拒绝伪通过或被篡改 Evidence。
- AC-7：Gate Result 与 Harness Report 能绑定并复核 task/wave 层级、波次和 AC 覆盖。
- AC-8：引擎拒绝非 Heavy 全量覆盖和一次性数据库，并在 persistent 策略下拒绝直接创建或删除数据库容器。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-006 工程 Toolchain 适配](../03-design/DES-006-engineering-toolchain-adapters.md) | 进行中 |
| Task | T1 [TASK-009](../04-task/TASK-009-git-worktree-gate.md)、范围 [TASK-016](../04-task/TASK-016-define-verification-scope.md)、Playwright [TASK-019](../04-task/TASK-019.md) | 已完成 |
| Task | [TASK-036 v2 Gate Planner 与 Spring Boot T2](../04-task/TASK-036-gate-planner-spring-toolchain.md) | 已批准 |

## 实际交付

- 已实现行为：T0 外部 Evidence 与 T1 通用命令 Gate；命令受 cwd、超时、环境限制约束，并生成绑定 Git HEAD 的 artifact。
- 已实现行为：显式 Playwright Web Gate 使用目标本地 CLI，强制解析测试统计，归档 HTML、JSON、截图和逐文件哈希，并接入 Harness Report 完整性复核。
- 已实现行为：`GATES.md` 可声明 `scope_kind`、`wave_id`、`coverage` 和数据库生命周期；非 Heavy 全量覆盖/一次性数据库、persistent Gate 直接创建删除容器以及执行后策略漂移均会被拒绝。
- 未实现行为：v2 自动 Gate Plan 与 Spring Boot T2 由 TASK-036 实施；Xcode/iOS、微信小程序按真实项目需求另建独立工单，不混入当前批次。
- 验证结论：T1 已通过自动化测试和两个真实 Git Project Dogfood；T2/T3 待后续阶段验证。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | Toolchain 分配到最终 Phase 3–5 | 最终 Roadmap定稿 | - |
| 2026-07-15 | 定义最小充分验证与升级规则 | 将反馈速度和正式交付完整性分开治理 | TASK-016 |
| 2026-07-23 | 增加 Playwright Web Gate | Web 功能必须用真实浏览器路径验证并产生原生 Evidence | TASK-019 |
| 2026-07-26 | 明确波次增量 Gate 与最终组合 Heavy | 降低多 Task 波次的重复验证次数 | TASK-016 |
| 2026-07-26 | 强制定向 Gate 与长期数据库复用 | 减少全量回归和数据库容器生命周期开销 | TASK-016 |
