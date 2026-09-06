# TASK-036：v2 Gate Planner 与 Spring Boot T2 Toolchain

- 状态：待验证
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-09-06
- 所属设计：[DES-006](../03-design/DES-006-engineering-toolchain-adapters.md)
- 所属特性：[FEAT-006](../02-feature/FEAT-006-engineering-toolchains.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-032
- 任务等级：Standard
- 协议版本：P/M/V/R v2
- 所属批次：P4-B3

## 目标

让 Controller 根据 Contract、HEAD、diff、依赖、风险和验证时机生成不可降级且可解释的最小 Gate Plan，并以 Spring Boot 作为首个 T2 原生 Toolchain。

## 工作范围

包括影响分析、Gate 选择和升级原因、Maven/Gradle/Java/module 发现、Surefire/JaCoCo 等原生 Evidence 解析、toolchain/environment hash；Xcode 和微信小程序只保留接口与后续独立工单入口。

## 验收标准

- [ ] AC-1：计划逐 AC 映射用例、工具、断言和 Evidence，不能缩减 P 批准的契约。
- [ ] AC-2：feedback、candidate、delivery、phase 时机与 targeted/full 范围严格分离。
- [ ] AC-3：Spring Boot Maven/Gradle 项目检测、模块选择、测试结果与报告解析准确并绑定当前 HEAD。
- [ ] AC-4：依赖、安全、迁移或构建系统变化触发可解释升级；普通改动不机械重放历史全量 Gate。
- [ ] AC-5：零测试、缺失报告、篡改 artifact、环境漂移或候选变化均 fail closed。
- [ ] AC-6：Toolchain 只产出事实和建议，不能自行判定 Candidate、Delivery 或发布。
- [ ] AC-7：Standard+Full、Heavy 缺少 wave/full、Gate 可执行文件缺失和 Java 主版本不足均在 M 启动前失败；所有 Evidence 路径拒绝符号链接与 realpath 越界。

## P/M/V/R 职责与验证范围

P 冻结工具与断言；M 实现 Planner/Adapter；V 使用真实 Maven/Gradle Fixture；R 复核 AC 覆盖和 Evidence hash。使用 `scope_kind: task`、`coverage: targeted`、`persistent/fixtures`。

## 实现与快速反馈记录

- 新增显式 `feedback/candidate/delivery/phase` Gate Planner；所有输出固定 `execution_authorized: false`，只产生建议。
- Planner 从获批 v2 Contract、稳定 HEAD、diff 和风险生成逐 AC Gate 映射、模块、影响、升级原因及成本；普通 Task 不生成 full/phase 计划。
- Spring T2 支持 Maven/Gradle wrapper、Java 与 module 发现，解析 Surefire/Gradle JUnit XML 和 JaCoCo XML，并绑定报告 hash 与当前 HEAD。
- 零测试、失败/错误/skipped、报告缺失/越界/篡改、候选变化和 phase 权限越界均 fail closed。
- 开工前联合校验 Task level、Gate scope/coverage、Provider Adapter、Gate executable 和工程声明 Java 主版本；相同约束在 Gate 入口再次检查。
- V/R、M self-test、通用 Gate 和 Spring 报告 Evidence 均拒绝符号链接或真实路径逃逸。
- 2026-09-04 快速反馈：编译通过；`test/toolchain.test.mjs` 1/1 通过。尚未执行正式独立 V/R。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 创建并批准 | 将 FEAT-006 未落地的 T2 范围收敛到当前真实项目需要的 Gate Planner 与 Spring Boot |
| 2026-09-04 | 实现候选进入待验证 | v2 Planner、Spring 检测和原生 Evidence hash 链完成 |
| 2026-09-06 | 故障加固 | 增加开工前范围/环境门禁和 Evidence realpath/symlink 防护 |
