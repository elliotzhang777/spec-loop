# TASK-024：飞书长连接回调与身份授权

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-08-04
- 最后更新：2026-08-06
- 所属设计：[DES-008](../03-design/DES-008-feishu-bot-connector.md)
- 所属特性：[FEAT-008](../02-feature/FEAT-008-feishu-progress-approval-connector.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 任务等级：Standard
- 依赖工单：TASK-023、Phase 4 Controller 结构化命令

## 目标

通过官方 SDK 长连接可靠接收飞书卡片动作，验证租户和操作者身份，并将合法决定幂等地交给既有 Controller 领域命令。

## 工作范围

### 包含

- 长连接事件处理、快速受理和持久 ActionInbox；
- 事件 ID、请求 ID 和动作 ID 三层去重；
- 单租户、项目级 open_id allowlist 和请求类型授权；
- Round/revision/hash/expiry/status Guard 与 compare-and-set 消费；
- Proposal、needs_user、Review、Verification 和 Heavy 的 Controller Adapter；
- 卡片结果更新和本地 CLI/对话回退入口。

### 不包含

- 自由文本意图识别、多租户、HTTP 公网回调和禁止的外部写操作。

## 验收标准

- [x] AC-1：回调在平台响应窗口内完成持久化和受理，耗时 Controller 操作异步执行。
- [x] AC-2：只有当前租户、项目和请求允许的 open_id 可以操作，其他身份全部拒绝并审计。
- [x] AC-3：过期、旧 revision、篡改、重复、已消费或当前状态不允许的动作不能推进 Task。
- [x] AC-4：合法动作只调用既有结构化领域命令，不能直接写 Task State、Approval、Review 或 Delivery 文件。
- [x] AC-5：重复回调和并发点击返回同一确定结果，Controller 最多执行一次有效状态迁移。
- [x] AC-6：飞书不可用或确认卡片未送达时，请求可由本地入口继续处理且审计语义一致。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1 | 慢 Controller 与响应时限集成测试 | 回调快速受理，后台完成 |
| AC-2、AC-3 | 错租户、越权用户、过期/篡改/旧候选对抗测试 | 全部 fail closed |
| AC-4 | 文件写入与领域调用边界测试 | Connector 无直接状态写权限 |
| AC-5 | 重推、双击和并发 CAS 测试 | 最多一次有效迁移 |
| AC-6 | 断网和本地回退 E2E | 同一请求可安全完成 |

## 验证范围

- `coverage: targeted`，覆盖回调、身份、幂等、Controller Adapter 和本地回退。
- 使用 Fake SDK/协议 fixture，不使用真实应用执行普通 Gate。

## 交付记录

- 完成日期：2026-08-06
- 变更文件/交付物：飞书 ActionInbox、身份与权限 Guard、结构化 Controller Adapter、本地等价确认入口、确认决定权威投影、崩溃恢复 fixture 和定向测试。
- 关键实现与决策：Inbox-first、异步 Controller、身份 allowlist、CAS 单次消费；Verification/Heavy 决定额外绑定 Round、revision、Acceptance、Gate Plan 与截图哈希；暂停只能由后续结构化选择恢复。
- 与原设计的差异：为消除确认锁竞争，回调预授权读取带完整性哈希的无锁投影；ActionInbox claim 增加进程所有者，启动时在远程 preflight 前回收死亡进程遗留状态。
- 遗留风险：真实应用身份和断线行为在 TASK-026 验证。
