# TASK-021：飞书连接器配置与 SDK 基础

- 状态：已批准
- 优先级：P0
- 负责人：待定
- 创建日期：2026-08-04
- 最后更新：2026-08-04
- 所属设计：[DES-008](../03-design/DES-008-feishu-bot-connector.md)
- 所属特性：[FEAT-008](../02-feature/FEAT-008-feishu-progress-approval-connector.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 任务等级：Standard
- 依赖工单：Phase 4 Controller 结构化命令接口草案

## 目标

建立默认关闭、可校验、无 Secret 落盘的飞书企业自建应用连接器基础，并通过官方 SDK 完成可替换的消息与长连接 Adapter。

## 工作范围

### 包含

- Feishu ConnectorConfig Schema、项目路由和操作者映射；
- 环境变量/OS Secret 引用、Token Provider 和统一日志脱敏；
- 官方 Node SDK 发送、更新卡片和长连接生命周期 Adapter；
- 连接器状态查询、启动、停止和配置检查 CLI；
- Fake Adapter，供普通测试在无真实凭据时运行。

### 不包含

- 具体进度卡片、确认业务和真实应用 Heavy Dogfood。

## 验收标准

- [ ] AC-1：缺少配置、权限或 Secret 时连接器明确拒绝启动，未启用时不影响现有本地闭环。
- [ ] AC-2：Secret、Token 和 Authorization header 不进入 Git、日志、错误、Task 或 Evidence。
- [ ] AC-3：SDK Adapter 可发送/更新测试卡片、建立/关闭长连接，并可被 Fake Adapter 替换。
- [ ] AC-4：配置严格校验单租户、接收目标、允许确认用户、通知策略和重试边界，未知字段或越界路径失败。
- [ ] AC-5：同一控制根通过 Connector lease 防止两个实例同时消费回调。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1、AC-4 | 配置 Schema 与 CLI 定向测试 | 合法配置通过，缺失/非法配置失败 |
| AC-2 | Secret canary 对抗测试与日志扫描 | 所有输出无明文 Secret/Token |
| AC-3 | Fake SDK Adapter 集成测试 | 生命周期和协议合同通过 |
| AC-5 | 双实例 lease 竞争测试 | 只有一个实例获得消费权 |

## 验证范围

- `coverage: targeted`，只验证 Connector 基础、配置、安全脱敏和 Adapter 合同。
- 不连接真实飞书，不运行 Phase 4 全量回归。

## 交付记录

- 完成日期：尚未实施（草稿阶段）
- 变更文件/交付物：实施完成后按实际结果记录
- 关键实现与决策：企业自建应用、官方 SDK 长连接、凭据外置。
- 与原设计的差异：无
- 遗留风险：真实租户权限和可用范围在 TASK-026 验证。
