# DES-006：工程 Toolchain 适配

- 状态：进行中
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-09-04
- 所属特性：[FEAT-006](../02-feature/FEAT-006-engineering-toolchains.md)

## 设计目标

把目标工程的发现、构建、测试和原生 artifact 统一转化成当前 Round/HEAD 的 Evidence。

## 现状与约束

- 现状：T0 外部 Evidence 与 T1 通用命令 Gate 已交付。
- 技术约束：Provider 与 Toolchain 分离；平台操作必须可审计和超时。
- 不在范围：Toolchain 直接判定 delivered；Phase 3 只实现 T1，T2/T3 进入 Phase 4，资产治理进入 Phase 5。

## 方案概览

```typescript
interface ToolchainAdapter {
  detect(repository: string): Promise<DetectionResult>;
  planGates(task: TaskContract, impact: ChangeImpact, stage: VerificationStage): Promise<GatePlan>;
  runGate(gate: GateDefinition, context: GateContext): Promise<GateResult>;
  collectEvidence(result: GateResult): Promise<EvidenceDraft[]>;
}
```

## 详细设计

### T1 通用命令

命令使用 argv 数组、固定 cwd、环境 allowlist、timeout，记录 stdout/stderr、exit code、duration 和 Git HEAD。

### Playwright Web Gate

`GATES.md` 可声明 `kind: playwright`，并通过 `ac` 指出覆盖的验收标准；控制 Task 的 `ACCEPTANCE.md.web_gates` 必须以相同 ID 和 AC 覆盖声明该 Gate 为必需项，两边不一致或整体省略时 fail closed。Runner 不接受任意 Playwright shell 命令，而是在目标 worktree 中查找本地 `@playwright/test/cli.js` 或 `playwright/cli.js` 及包名/版本元数据，用当前 Node 进程启动 `test`。配置和测试入口必须是解析后仍位于 worktree 内的真实普通路径；服务启动、baseURL、认证夹具等由目标工程版本化的 Playwright config 管理。

Runner 强制使用：

- 独立 `test-results` 输出目录；
- JSON report，用于证明 `expected >= 1`，并包含实际 passed 的 suite/spec/test/result 结构；
- HTML report，用于复核步骤和失败；
- 当 `require_screenshots: true` 时，至少一张通过 CRC、压缩流、尺寸和扫描行完整校验的 PNG 截图；纯功能路径可以显式关闭该要求，但不能替代视觉 Review；
- 当前 Base/HEAD、stdout/stderr、timeout 和退出码；
- 包含所有报告、trace、video 和截图的逐文件 SHA-256 Manifest。

以下结果 fail closed：目标工程未安装由 Git 跟踪锁文件约束的本地 Playwright、Web Gate 未绑定 AC、零通过测试、unexpected、flaky、skipped、超时、JSON/HTML 缺失或非法、声明为必需的有效 PNG 截图缺失、完整 Gate Plan 或数据库策略变化、Manifest/附件被替换、测试路径越界、Gate 期间或 Report 之后 HEAD/候选内容指纹变化。内容指纹覆盖 tracked 与未忽略的 untracked 文件，并用 tombstone 表示删除；旧 Collect Evidence 缺少指纹时必须重新执行 Collect。Harness Report、最终 Verification 和 reconcile 都会重新读取当前现场与 Evidence，而不是只相信 Gate Result 自报；PASS 后 Gate ID 会进入本轮原生 Evidence，Delivery 的 Web AC 必须映射到该 Evidence。

### 影响分析与 Gate Plan

T2/T3 `planGates` 读取 base/HEAD diff、touched files、模块依赖、Task AC、风险等级、测试配置变更和验证时机，输出：

- `stage`：feedback、candidate、delivery 或 phase；
- `impact`：resource、local-code、cross-module、core/security/release；
- `selected_gates` 与每项覆盖的 AC/风险；
- `skipped_gates` 与跳过理由；
- `escalation_triggers`；
- 预估时间和资源成本。

默认矩阵：

| 改动类型 | Feedback 默认 Gate | Delivery 默认 Gate |
|---|---|---|
| 文档 | 格式、链接、Schema | Task 规格一致性检查 |
| 图标/文案/静态资源/局部样式 | 资源检查、目标 build、定向 smoke/视觉确认 | Task 完整 Gate 一次 |
| 局部业务代码 | 受影响单测、相邻集成测试、目标 build | 本 Task AC、改动模块与直接依赖的完整 Gate |
| 公共契约/数据迁移/并发/安全/依赖/构建系统 | 相关子系统或全量回归 | 完整 Gate + 独立 Verifier |
| 阶段验收/外部发布 | 不适用 | 阶段计划规定的全量、对抗和 Dogfood |

业务波次拆成多个 Task 时，Planner 为每个 Task 只生成 `task_scope`：Task AC、touched modules、direct dependents 和必要相邻集成测试。已交付的兄弟 Task 不进入当前 Gate Plan，除非依赖图证明本次改动影响它们。波次最终阶段工单使用 `wave_scope`，在所有 Task 合入后只生成一次跨模块、端到端、对抗与回归 Gate。Gate Plan 必须记录 `scope_kind: task | wave`，禁止把 `task` Evidence 提升为 `wave` Evidence。

当前 T1 已支持显式范围契约：`GATES.md.scope_kind` 可取 `task` 或 `wave`，`wave_id` 绑定业务波次，每个命令或 Playwright Gate 用 `ac` 声明覆盖。`coverage` 可取 `targeted` 或 `full`；Light/Standard Task 使用 `full` 会 fail closed，`wave` 必须绑定 `wave_id`、使用 `full` 且当前 Task 必须为 Heavy。Gate Result 哈希绑定完整有序 Gate Plan，包括 scope、wave、coverage、数据库 lifecycle/reset/reason 和各 Gate 的命令、测试选择、项目、grep、超时、截图策略与 AC；Report 阶段重新比较，防止执行后复用或升级旧 Evidence。

Gate Plan 还声明数据库生命周期。默认
`database: { lifecycle: persistent, reset: fixtures }`，复用工程长期验证数据库；
也可选择 transaction 或 schema reset。persistent Gate 禁止直接运行
Docker/Podman 容器创建、删除命令，Harness 将 coverage、lifecycle 和 reset 注入
目标进程并记录到 Evidence。只有迁移、初始化、升级/回滚或隔离证明类 Heavy Task
可以使用 `disposable`，且必须给出原因。

Gate Planner 只生成可解释的建议，不自行授予执行权限。Controller 使用已批准 Task/波次的范围、权限、Gate 计划和预算作为持续执行授权，可在该范围内进入 delivery 并修复复验；候选变化要求重建计划/Evidence，不要求再次授权同一范围。单独 feedback 不升级为 delivery；新增 AC、权限、Gate 计划或预算先暂停受影响范围。最终视觉/Heavy/阶段验收和外部动作统一提交明确决定；既有覆盖与 Evidence 核实不降低。

### Spring Boot 工具链

发现 Maven/Gradle wrapper、Java version 和 module；运行 test/verify/check；后续解析 Surefire、JaCoCo、Checkstyle 和 SpotBugs。

### Xcode/iOS

发现 workspace/project、scheme、configuration、SwiftPM/CocoaPods/Tuist；运行 `xcodebuild build/test`；每任务 DerivedData；后续解析 XCResult 并租赁 Simulator。签名、Archive、TestFlight、App Store 为 Heavy 人工门禁。

### 微信小程序

发现 project config、package scripts 和 miniprogram root；收集 npm、构建、截图和人工设备证据。登录、支付、授权为 Heavy。

## 方案取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 先通用命令再平台预设 | 可快速覆盖多数项目 | 原生证据较浅 | 采用 |
| 一开始深度集成所有平台 | 体验好 | 范围过大 | 拒绝 |

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| 本地环境差异 | Gate 不稳定 | detect + doctor + 固定配置 | 回退 T0 Evidence |
| Xcode 资源冲突 | 测试污染 | 独立 DerivedData + simulator lease | 串行执行 |
| 验证范围过大 | 反馈周期失控、重复消耗 | 分离 feedback 与 delivery，选择最小充分 Gate | 回退人工 Gate Plan |
| 验证范围过小 | 回归漏检 | 依赖分析、升级条件、最终完整 Gate | 升级到子系统或全量回归 |

## 验证策略

每个 Adapter 使用真实 fixture、失败场景、artifact hash 和 HEAD 失效测试；UI/真机项目保留人工 AC。

## 工单拆分

Phase 3 T1 runner、TASK-016 验证范围规范和 TASK-019 Playwright Web Gate 已完成；[TASK-036](../04-task/TASK-036-gate-planner-spring-toolchain.md) 负责 v2 自动 Gate Plan 与首个 Spring Boot T2 原生适配。Xcode/iOS、微信小程序在真实项目进入后分别建立工单，不与 Spring 工单共享验收范围；Phase 5 再进入 Adapter 资产治理。

## 实际实现

- 已实现：T1 runner 使用固定 cwd、受限环境、timeout，记录退出码、stdout/stderr、artifact hash 与真实 Git HEAD；显式 Playwright Web Gate 解析原生 JSON、归档 HTML/截图/附件 Manifest，并由 Harness Report 复核；显式 task/wave、targeted/full、数据库生命周期和 AC 映射会进入 Gate Evidence。
- 已完成：TASK-036 的 v2 Gate Plan 与 Spring Boot Maven/Gradle/Java/module 发现、Surefire/Gradle JUnit 和 JaCoCo Evidence 在 `af57702` 独立 V/R PASS；计划校验批准契约追踪，原生报告绑定同 HEAD 已验证 Gate、环境和候选内容指纹，新增或篡改报告失效。
- 已完成：TASK-038 的本机 `products/` 下按工程标识和版本分层的出口、manifest/SHA256SUMS 与 Git 忽略边界在 `eca847d` 独立 V/R PASS；示例 APK 与源构建物字节哈希一致。版本目录不在 Git HEAD 中，源码为未提交工作树，不能据此推断可重构或真机验收。
- 未实现：自动 Web 检测；Xcode/iOS、微信小程序的 T2/T3 平台预设和原生结果解析（按本设计保留为后续独立工单）。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 建立 Toolchain 设计草案 | 规格库重组 | - |
| 2026-07-15 | 增加影响分析和分级 Gate Plan | 低风险反馈优先快速验证，最终交付统一完整验证 | TASK-016 |
| 2026-07-23 | 增加 Playwright Web Gate 与附件 Manifest | 让 Web 功能测试成为可证明、可复验的浏览器 Evidence | TASK-019 |
| 2026-07-25 | 把验证阶段升级与技术影响升级分离 | 高影响只影响建议范围，不能替代用户的正式交付授权 | TASK-016 |
| 2026-07-26 | 增加 task_scope 与 wave_scope | 多 Task 波次只在最终阶段运行一次全量组合验证 | TASK-016 |
| 2026-07-26 | 增加 coverage 与数据库生命周期门禁 | 非 Heavy 只跑定向 Gate，普通验证复用长期数据库 | TASK-016 |
| 2026-09-04 | 将 v2 Gate Planner 与 Spring Boot T2 拆为 TASK-036 | 对齐 P 契约、Controller 计划、V 执行和 R 证据复核边界 | TASK-036 |
| 2026-09-29 | 本机成品出口完成定向验收 | TASK-038 的目录、清单、哈希和忽略规则独立 V/R PASS；保留本机证据边界 | TASK-038 |

## 2026-10-01 第九轮技术验收同步

TASK-059 已将 Spring T2 PASS 绑定目标工程测试前后相同的干净 HEAD，真实 Maven 2/2 PASS；TASK-062 修复隔离工作树的 Playwright CLI 本地依赖，最终受控 E2E 2/2 及截图归档 PASS。见[第九轮完整矩阵](../05-delivery/2026-10-01-Phase4-第九轮完整测试矩阵.md)。
