# DES-008：飞书正式机器人连接器

- 状态：已批准
- 负责人：待定
- 创建日期：2026-08-04
- 最后更新：2026-08-04
- 所属特性：[FEAT-008](../02-feature/FEAT-008-feishu-progress-approval-connector.md)

## 设计目标

通过飞书企业自建应用机器人，把 Spec-Loop 的项目进度和待确认请求安全投影到飞书，并将授权用户的结构化决定幂等地交给既有 Controller，同时保持本地 Task、State History、Evidence 和 Delivery 为唯一事实源。

## 现状与约束

- 现状：Phase 3 已能在本地请求视觉 Review、正式验证和 Heavy 确认，但用户必须回到当前会话或 CLI 查看状态并操作。
- 官方约束：企业自建应用可通过官方 SDK 长连接接收事件和卡片回调；运行环境需要访问公网，不需要公网入站地址；回调处理有约 3 秒响应要求。
- 平台约束：发送消息需要机器人能力、应用访问凭证和目标用户/群的可用范围，且存在按用户或群的频率限制。
- 技术约束：Phase 4 Controller 必须提供结构化、幂等的确认命令；Connector 不能直接编辑 Task 控制文件。
- 不在范围：群自定义 Webhook、商店应用、多租户 SaaS、飞书任务中心同步、自由文本 Agent 对话、自动 merge/push/deploy。

## 关键决策

| 决策 | 采用方案 | 原因 |
|---|---|---|
| 应用类型 | 企业自建应用机器人 | 具备正式身份、权限控制、主动消息和交互回调，符合用户明确要求 |
| 事件接入 | 官方 SDK 长连接 | 适合本地优先运行，不要求公网回调地址，并由 SDK 处理建连鉴权 |
| 状态关系 | 飞书是 Projection，Task/State/Evidence 仍是事实源 | 防止卡片状态与本地闭环分叉 |
| 回调处理 | 先持久化 Inbox，再快速确认，异步调用 Controller | 满足响应窗口并保留故障恢复能力 |
| 授权载荷 | 卡片只回传不透明请求 ID 和固定动作 ID | 不信任客户端回传 scope、risk、revision 等权威字段 |
| 身份模型 | 单租户绑定＋允许操作的 `open_id` 映射 | MVP 足以识别远程操作者，避免任意群成员批准 |
| 凭据 | 环境变量或操作系统 Secret 引用 | 避免凭据进入 Git、规格和 Evidence |
| 消息策略 | 项目进度卡更新＋关键事件独立卡片 | 降低刷屏，同时保留待确认事项的可见性 |

## 方案概览

```text
Task / Harness / Gate / Review / Delivery Events
                    ↓
           Progress Projector
                    ↓
             Durable Outbox ──→ Feishu OpenAPI ──→ Progress / Approval Card
                                                            ↓
Feishu WebSocket Client ←── card.action.trigger ←── Authorized User
          ↓
    Durable Inbox → Identity + Request Guard → Controller Command
                                           ↓
                          State / Evidence / Audit → Card Update
```

连接器由五个逻辑部件组成：

1. `FeishuClient`：官方 SDK 长连接、令牌管理、消息发送与卡片更新适配。
2. `ProgressProjector`：从本地事实生成项目/任务进度快照，不反向持有业务状态。
3. `NotificationOutbox`：保存待发送、重试、已发送和永久失败记录。
4. `ActionInbox`：保存原始事件摘要、去重键、处理状态和拒绝原因。
5. `ConfirmationGuard`：验证身份、租户、请求、Task、Round、revision、内容哈希、有效期和单次消费状态，然后调用 Controller 的结构化命令。

## 详细设计

### 配置与凭据

项目控制根下维护本地忽略的 `connectors/feishu/config.json`，只保存非密钥配置：

- `enabled`、`tenant_key` 和应用 ID 的非敏感引用；
- 接收目标 `receive_id_type + receive_id`；
- 允许确认的 `open_id → local_actor` 映射；
- 项目路由、通知级别、静默时间和聚合窗口；
- 长连接模式、重试策略和卡片模板版本。

`app_secret` 与访问令牌只从环境变量或操作系统 Secret Provider 读取。日志统一通过 Redactor 处理 Authorization header、secret、token、原始回调和个人标识；诊断信息只保留哈希、末尾掩码和平台 request ID。

### 进度投影

`ProgressSnapshot` 从 Project Registry、Task State、Harness State 和最近 Evidence 重算：

- 阶段/波次名称和总 Task 数；
- 草稿、待执行、执行中、待验证、阻塞、已完成数量；
- 当前 Task、当前 Round、当前 Harness 步骤；
- 最近一次 Gate/Verifier 结论和时间；
- 当前是否 `needs_user`、需要用户做什么；
- 下一自动动作和最近更新时间。

同一项目默认只有一张活跃进度卡，按 `(project_id, wave_id)` 保存 `message_id`。Attempt、日志行和短暂步骤只更新快照，不逐条发送；状态切换、失败、需要用户、恢复和 Delivery 才触发 Outbox。聚合窗口内只保留最新快照。

### 确认请求

`ConfirmationRequest` 是本地权威对象，至少包含：

- `request_id`、`type`、`project_id`、`task_id`；
- `round`、`revision`、`content_hash`、`risk`；
- `allowed_actions`、`allowed_actor_ids`；
- `created_at`、`expires_at`、`status`、`consumed_at`；
- 对应 Proposal、Review、Gate Plan 或 Delivery 的事实引用。

MVP 支持以下类型：

| 类型 | 卡片动作 | 本地结果 |
|---|---|---|
| Proposal | 批准、拒绝 | 调用既有 Proposal Approval/Reject 领域命令 |
| `needs_user` | 选择预定义选项、暂停 | 记录结构化用户决定并恢复或保持暂停 |
| Visual Review | 通过、拒绝 | 绑定当前截图哈希、Round 和 revision |
| Verification | 授权正式验证、暂不验证 | 创建只对当前候选单次有效的 verification authorization |
| Heavy Acceptance | 通过、拒绝 | 记录当前 Delivery 候选的人类最终决定 |

自由文本只能作为评论附加到请求，不得推导批准。卡片不提供 merge、push、deploy、生产修改、Secret 或权限扩大按钮。

### 长连接与回调

使用官方 Node SDK 启动企业自建应用长连接客户端。每个本地控制实例只维持一个连接并使用 Connector lease 防止同一控制根重复消费。收到卡片回调后：

1. 解析平台事件 ID、租户、操作者 `open_id`、请求 ID 和固定动作 ID；
2. 在单一原子事务中写入 Inbox，重复事件直接返回已有受理结果；
3. 在平台响应窗口内确认接收，不同步等待 Gate、Agent 或 Git 操作；
4. Worker 从 Inbox 读取并执行 Confirmation Guard；
5. Controller 成功写入本地事实后标记 consumed，并更新原卡片；
6. 失败时记录可重试或永久拒绝原因，不猜测任务是否已推进。

长连接断开后按 SDK 能力重连；重启时先 reconcile Inbox/Outbox 和本地 ConfirmationRequest。多个连接不用于广播，MVP 不支持多实例主动-主动。

### 身份与授权

身份校验按以下顺序 fail closed：

1. 应用和租户与本地 ConnectorConfig 一致；
2. 操作者 `open_id` 在当前项目与请求类型的 allowlist 中；
3. 请求存在、未过期、未消费且允许该动作；
4. 当前 Task、Round、revision、内容哈希和风险仍与请求一致；
5. Controller 当前状态允许该迁移；
6. 使用 compare-and-set 消费请求并写审计，失败则重新读取并返回确定结果。

飞书身份只证明“哪个绑定用户点击了卡片”，不能绕过 Spec-Loop 原有 Approval、Review、Verification 和 Delivery Guard。

### Outbox、限流与失败恢复

Outbox 状态为 `pending → sending → sent | retry_wait | dead_letter`，记录幂等键、目标、卡片类型、模板版本、payload hash、尝试次数、下一重试时间、平台 request ID 和 `message_id`。发送前再次从本地事实生成卡片，旧快照可被新快照合并取代。

- 429、网络错误和平台 5xx：指数退避并加入抖动，遵守服务端重试提示；
- 目标不可用、机器人不在群、权限不足：进入 dead-letter 并产生本地告警；
- Token 过期：通过 SDK/Token Provider 刷新后单次重试；
- 卡片已删除或不可更新：重新发送并替换 `message_id`；
- 普通进度失败：不阻断 Task；确认卡片失败：请求保持 pending，Task 进入或保持 `needs_user`。

### 审计与隐私

审计事件包含 connector、project、task、request、event、actor 映射、动作、决策、拒绝原因、时间和相关本地 revision。个人标识默认哈希化展示，原始 open_id 仅保存在本机受限配置/状态中。卡片摘要不得包含源码 diff、完整日志、Secret、Token、客户数据或未显式允许的 Evidence 内容。

## 方案取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 企业自建应用＋长连接 | 正式身份、双向卡片、本地无需公网入口 | 需要管理员配置应用与权限，进程需持续联网 | 采用 |
| 企业自建应用＋公网 HTTP 回调 | 易于集中部署和横向扩容 | 本地使用需要公网域名、TLS、验签与防护 | Phase 4 MVP 不采用，后续可扩展 |
| 群自定义 Webhook | 发送简单 | 缺少正式双向身份与结构化确认闭环 | 拒绝 |
| 飞书直接保存 Task 状态 | 卡片查询简单 | 形成第二事实源，断网后分叉 | 拒绝 |
| 自由文本回复作为批准 | 交互自然 | 语义歧义，无法绑定候选与范围 | 拒绝 |

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| 旧卡片批准新候选 | 未授权执行 | revision/content hash/expiry/状态 Guard | 拒绝请求，生成新卡片 |
| 重复事件导致重复迁移 | Task 状态损坏 | event/request/action 三层幂等与 CAS | reconcile Inbox 和 Task History |
| 飞书或网络不可用 | 用户看不到进度或无法确认 | Outbox 重试、本地告警和本地确认回退 | 禁用 Connector，继续本地闭环 |
| 凭据泄露到日志或 Evidence | 应用被冒用 | Secret Provider、统一 Redactor、泄漏对抗测试 | 吊销 Secret、暂停 Connector |
| 群成员越权点击 | 高风险误授权 | 单租户、项目级 open_id allowlist、请求类型授权 | 拒绝并审计 |
| 高频状态刷屏或触发限流 | 用户干扰、消息失败 | 聚合窗口、单卡更新、优先级队列和退避 | 降级为阶段摘要 |

## 验证策略

| 验收范围 | 验证层级 | 方法 | 预期结果 |
|---|---|---|---|
| 配置、凭据和权限 | 单元/对抗 | 缺配置、Secret 泄漏、权限扩大、错误租户 | fail closed，输出无 Secret |
| 进度投影与 Outbox | 单元/集成 | 高频事件、限流、5xx、重启、卡片丢失 | 合并、重试、reconcile，无重复关键消息 |
| 确认请求 Guard | 单元/对抗 | 过期、旧 revision、重复、越权、篡改动作 | 全部拒绝且不改变 Task |
| 长连接回调 | 集成 | 官方 SDK 测试适配器、3 秒受理、断线重连 | 快速确认，异步且幂等处理 |
| Controller 集成 | E2E | Proposal、needs_user、Review、Verification、Heavy | 飞书决定与本地状态和审计一致 |
| 真实机器人 | Dogfood/Heavy | 真实企业自建应用发送、失效、批准、恢复 | 全链路 PASS，独立 Verifier 和人工验收通过 |

普通 Task 只运行自身定向 Gate；TASK-026 才执行飞书能力全量组合 Heavy。真实应用凭据不进入测试 artifact，CI/普通测试使用协议级 Fake Server 或 SDK Adapter。

## 工单拆分

| 工单 | 交付物 | 依赖 | 状态 |
|---|---|---|---|
| [TASK-021](../04-task/TASK-021-feishu-connector-foundation.md) | Connector 配置、Secret Provider 和官方 SDK 适配基础 | Phase 4 Controller 接口草案 | 已完成 |
| [TASK-022](../04-task/TASK-022-feishu-progress-outbox.md) | 进度投影、卡片渲染和可靠 Outbox | TASK-021 | 已完成 |
| [TASK-023](../04-task/TASK-023-feishu-confirmation-contract.md) | 确认请求、卡片动作和候选绑定契约 | TASK-021 | 已完成 |
| [TASK-024](../04-task/TASK-024-feishu-callback-identity.md) | 长连接回调、身份授权、幂等消费和 Controller 接入 | TASK-023 | 已完成 |
| [TASK-025](../04-task/TASK-025-feishu-recovery-security.md) | 重试、reconcile、审计、隐私和对抗 Gate | TASK-022、TASK-024 | 已批准 |
| [TASK-026](../04-task/TASK-026-feishu-heavy-dogfood.md) | 真实机器人 Dogfood、独立 Verifier 和最终 Heavy | TASK-021～025 | 已批准 |

## 实际实现

- 最终实现：TASK-021～024 已完成；已具备配置与 Secret Provider、进度 Outbox、确认契约、长连接回调、身份授权、幂等消费和结构化 Controller 接入。
- 与设计差异：回调预授权使用带完整性哈希的无锁 Confirmation 投影；ActionInbox claim 记录进程所有者，并在远程 preflight 前执行启动恢复。
- 运维/迁移说明：实施前需要用户在飞书开放平台创建企业自建应用、开启机器人能力、配置最小权限并提供本机 Secret 引用和测试接收目标。
- 关联完成工单：TASK-021、TASK-022、TASK-023、TASK-024。

## 官方参考

- [使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)
- [事件订阅概述](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview?from=from_parent_docs)
- [接收和处理卡片回调](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks?lang=zh-CN)
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-08-04 | 起草企业自建应用长连接方案 | 满足本地优先、正式身份、进度通知和远程确认闭环 | TASK-021～026 |
