# DES-006：工程 Toolchain 适配

- 状态：待验证
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-26
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
- 至少一张通过 CRC、压缩流、尺寸和扫描行完整校验的 PNG 截图；
- 当前 Base/HEAD、stdout/stderr、timeout 和退出码；
- 包含所有报告、trace、video 和截图的逐文件 SHA-256 Manifest。

以下结果 fail closed：目标工程未安装本地 Playwright、Web Gate 未绑定 AC、零通过测试、unexpected、flaky、skipped、超时、JSON/HTML 缺失或非法、有效 PNG 截图缺失、Manifest/附件被替换、测试路径越界、Gate 期间或 Report 之后 HEAD/候选内容指纹变化。内容指纹覆盖 tracked 与未忽略的 untracked 文件，并用 tombstone 表示删除；旧 Collect Evidence 缺少指纹时必须重新执行 Collect。Harness Report、最终 Verification 和 reconcile 都会重新读取当前现场与 Evidence，而不是只相信 Gate Result 自报；PASS 后 Gate ID 会进入本轮原生 Evidence，Delivery 的 Web AC 必须映射到该 Evidence。

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

当前 T1 已支持显式范围契约：`GATES.md.scope_kind` 可取 `task` 或 `wave`，`wave_id` 绑定业务波次，每个命令或 Playwright Gate 用 `ac` 声明覆盖。`coverage` 可取 `targeted` 或 `full`；Light/Standard Task 使用 `full` 会 fail closed，`wave` 必须绑定 `wave_id`、使用 `full` 且当前 Task 必须为 Heavy。Gate Result 固化 scope/wave/coverage/AC，Report 阶段重新与当前 Gate Plan 比较，防止执行后把局部 Evidence 改写成整轮 Evidence。

Gate Plan 还声明数据库生命周期。默认
`database: { lifecycle: persistent, reset: fixtures }`，复用工程长期验证数据库；
也可选择 transaction 或 schema reset。persistent Gate 禁止直接运行
Docker/Podman 容器创建、删除命令，Harness 将 coverage、lifecycle 和 reset 注入
目标进程并记录到 Evidence。只有迁移、初始化、升级/回滚或隔离证明类 Heavy Task
可以使用 `disposable`，且必须给出原因。

Gate Planner 的影响判断不能自行改变验证阶段。Task/Loop 启动仅进入 `feedback`；只有用户对当前稳定候选显式授权后，Controller 才可请求 `delivery`，阶段验收则单独授权。候选变化后旧授权失效。选择范围必须可解释、可审计；定向 Gate 失败、依赖关系不明确或 touched files 超出声明范围时，Planner 只能建议扩大检查并请求授权，不得静默缩小范围或自行启动正式交付。

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

实现顺序为 Phase 3 T1 runner、TASK-016 验证范围规范、TASK-019 显式 Playwright Web Gate、Phase 4 自动发现与 Spring/Xcode/小程序 T2/T3、Phase 5 Adapter 资产治理。用户已明确授权 TASK-019；它不包含 Phase 4 自动 Controller 或 Scheduling。

## 实际实现

- 已实现：T1 runner 使用固定 cwd、受限环境、timeout，记录退出码、stdout/stderr、artifact hash 与真实 Git HEAD；显式 Playwright Web Gate 解析原生 JSON、归档 HTML/截图/附件 Manifest，并由 Harness Report 复核；显式 task/wave、targeted/full、数据库生命周期和 AC 映射会进入 Gate Evidence。
- 未实现：自动 Web 检测与 Gate Plan；Spring Boot、Xcode/iOS、微信小程序的 T2/T3 平台预设和原生结果解析。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 建立 Toolchain 设计草案 | 规格库重组 | - |
| 2026-07-15 | 增加影响分析和分级 Gate Plan | 低风险反馈优先快速验证，最终交付统一完整验证 | TASK-016 |
| 2026-07-23 | 增加 Playwright Web Gate 与附件 Manifest | 让 Web 功能测试成为可证明、可复验的浏览器 Evidence | TASK-019 |
| 2026-07-25 | 把验证阶段升级与技术影响升级分离 | 高影响只影响建议范围，不能替代用户的正式交付授权 | TASK-016 |
| 2026-07-26 | 增加 task_scope 与 wave_scope | 多 Task 波次只在最终阶段运行一次全量组合验证 | TASK-016 |
| 2026-07-26 | 增加 coverage 与数据库生命周期门禁 | 非 Heavy 只跑定向 Gate，普通验证复用长期数据库 | TASK-016 |
