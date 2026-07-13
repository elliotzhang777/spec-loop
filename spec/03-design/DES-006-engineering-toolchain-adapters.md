# DES-006：工程 Toolchain 适配

- 状态：部分完成（T1 已交付，T2/T3 为草稿）
- 负责人：待定
- 创建日期：2026-07-12
- 最后更新：2026-07-12
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
  planGates(task: TaskContract): Promise<GateDefinition[]>;
  runGate(gate: GateDefinition, context: GateContext): Promise<GateResult>;
  collectEvidence(result: GateResult): Promise<EvidenceDraft[]>;
}
```

## 详细设计

### T1 通用命令

命令使用 argv 数组、固定 cwd、环境 allowlist、timeout，记录 stdout/stderr、exit code、duration 和 Git HEAD。

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

## 验证策略

每个 Adapter 使用真实 fixture、失败场景、artifact hash 和 HEAD 失效测试；UI/真机项目保留人工 AC。

## 工单拆分

实现顺序为 Phase 3 T1 runner、Phase 4 Spring/Xcode/小程序 T2 与必要 T3、Phase 5 Adapter 资产治理。各阶段未授权前不创建工单。

## 实际实现

- 已实现：T1 runner 使用固定 cwd、受限环境、timeout，记录退出码、stdout/stderr、artifact hash 与真实 Git HEAD；由 TASK-009 交付并完成真实 Dogfood。
- 未实现：Spring Boot、Xcode/iOS、微信小程序的 T2/T3 平台预设和原生结果解析。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 建立 Toolchain 设计草案 | 规格库重组 | - |
