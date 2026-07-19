# DES-006：工程 Toolchain 适配

- 状态：待验证
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-15
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
| 局部业务代码 | 受影响单测、相邻集成测试、目标 build | Task 完整 Gate |
| 公共契约/数据迁移/并发/安全/依赖/构建系统 | 相关子系统或全量回归 | 完整 Gate + 独立 Verifier |
| 阶段验收/外部发布 | 不适用 | 阶段计划规定的全量、对抗和 Dogfood |

选择范围必须可解释、可审计。定向 Gate 失败、依赖关系不明确或 touched files 超出声明范围时自动升级；不得静默缩小验证范围。

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

实现顺序为 Phase 3 T1 runner、TASK-016 验证范围规范、Phase 4 Spring/Xcode/小程序 T2 与必要 T3、Phase 5 Adapter 资产治理。各阶段未授权前不创建实现工单。

## 实际实现

- 已实现：T1 runner 使用固定 cwd、受限环境、timeout，记录退出码、stdout/stderr、artifact hash 与真实 Git HEAD；由 TASK-009 交付并完成真实 Dogfood。
- 未实现：Spring Boot、Xcode/iOS、微信小程序的 T2/T3 平台预设、原生结果解析和自动 Gate Planner。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 建立 Toolchain 设计草案 | 规格库重组 | - |
| 2026-07-15 | 增加影响分析和分级 Gate Plan | 低风险反馈优先快速验证，最终交付统一完整验证 | TASK-016 |
