# DES-009：执行事件、可重建投影与本地观察面

- 状态：已批准
- 负责人：Codex
- 创建日期：2026-08-12
- 最后更新：2026-08-31
- 所属特性：[FEAT-009](../02-feature/FEAT-009-execution-visualization.md)

## 设计目标

覆盖 FEAT-009 的全部 AC：用项目 `.spec-loop/` 中可审计的事实重建执行图，准确表达当前 Task/步骤、历史步骤含义和耗时，并提供只读、本机、可实时刷新的 Web 观察面。

## 现状与约束

- `TASK_STATE.md` 能说明当前生命周期；`STATE_HISTORY.jsonl` 能校验状态序列，但 v1 记录没有时间戳，无法还原各状态耗时。
- `LOOP_LEDGER.jsonl` 有 Attempt 时间点和动作摘要，但没有步骤开始/结束配对，不能独立计算 Attempt 时长。
- Harness State 只保存最后 stage；prepare/collect/Gate 等产物保存部分时间点，Gate 已有精确 `duration_ms`，历史 stage 仍不完整。
- Project Task Registry 已经可以从 `.spec-loop/tasks/` 重建，飞书进度投影已有选择 active Task 和校验当前 Harness Evidence 的逻辑，但没有统一的时间模型和用户界面。
- `TASK_STATE.md`、Ledger、Harness State、Evidence 和 Delivery 的现有权威边界不得改变；页面不能成为第二状态源。
- 本能力是只读可观测性增强，不启动 Scheduler、自动 Controller、并发执行、push、merge 或外部 Connector 写入。

## 方案概览

```text
现有权威事实 ───────────────┐
Task State / Ledger          │
Harness / Gate / Evidence    ├─→ Projection Builder ─→ Snapshot API ─→ Local Web UI
Review / Delivery            │          ↑                    ↑
                             │          │                    │ 1s conditional refresh
新增 EXECUTION_EVENTS.jsonl ─┘     可删除缓存            loopback + GET only
        ↑
Lifecycle / Harness / Gate / Review / Delivery 埋点
```

核心选择是“事件补齐时间事实，投影负责展示语义”。事件流只新增过去没有保存的观测事实；生命周期结果仍以原权威文件为准。页面每次可以全量重建，也可以在内存中按事件尾部增量更新；任何缓存都可删除。

## 详细设计

### 执行事件协议

项目新增 `.spec-loop/EXECUTION_EVENTS.jsonl`。每行是严格 schema 的 hash-chained event：

```json
{
  "schema_version": 1,
  "sequence": 42,
  "event_id": "uuid",
  "step_run_id": "uuid",
  "project_id": "PROJ-DEMO",
  "task_id": "TASK-027",
  "round": 1,
  "run_id": "uuid-or-null",
  "kind": "step_started",
  "step_type": "harness.execute",
  "label": "Agent 实现",
  "summary": "Codex 在隔离 worktree 中按已批准计划修改候选",
  "occurred_at": "2026-08-12T08:00:00.000Z",
  "outcome": null,
  "refs": [],
  "previous_hash": "64-hex-or-null",
  "event_hash": "64-hex"
}
```

`kind` 首版为 `step_started | step_succeeded | step_failed | step_interrupted | wait_started | wait_ended | annotation`。终止事件与开始事件复用 `step_run_id`；只有 `annotation` 允许 `step_run_id: null`。耗时由两个 `occurred_at` 相减，避免在多个位置保存可漂移的 duration。`refs` 只允许项目控制目录内的逻辑相对路径、Evidence ID 和内容 hash，不保存任意绝对路径。

`step_type` 使用受控词表：

| Step type | 页面文案 | 表达的事实 |
|---|---|---|
| `task.plan` | 规格与计划 | 校验 Task 契约并冻结 AC |
| `round.work` | 本轮实现 | 在当前 Round 推进实现或修复 |
| `work.reproduce` | 问题复现 | 建立稳定复现条件并确认失败边界 |
| `work.analyze` | 根因分析 | 阅读代码、日志和契约并形成可验证根因 |
| `work.change` | 代码修改 | 实施当前修复或功能变更 |
| `harness.prepare` | 准备执行 | 校验授权、候选、worktree 和计划 |
| `harness.execute` | Agent 实现 | Provider 在隔离 worktree 执行批准步骤 |
| `harness.collect` | 收集改动 | 重新读取 HEAD、工作树和 diff |
| `gate.command` / `gate.playwright` | 确定性验证 | 执行构建、测试或真实浏览器路径 |
| `review.visual` | 人工效果确认 | 等待或记录用户对当前截图的判断 |
| `task.verify` | 独立验证 | 将当前 Round 与 Evidence 签署为通过或拒绝 |
| `task.deliver` | 交付关闭 | 校验 AC→Evidence 映射并关闭 Task |
| `wait.user` | 等待用户 | 等待输入、视觉确认、验证授权或 Heavy 验收 |

所有写事件的入口共享单一 writer，在项目级短锁内完成序号、前序哈希、事件 hash 和原子追加。业务操作和事件写入无法形成单文件事务时，业务权威写入优先；恢复时根据权威文件生成 `annotation` 或 `step_interrupted`，不得反向修改业务结果以迁就事件流。

事件埋点只在 CLI 能解析到 managed Project root 时启用；既有独立 Task 目录继续按原协议工作，不因缺少 Project 或 `EXECUTION_EVENTS.jsonl` 而失败。

### 投影数据模型

`buildExecutionSnapshot(projectRoot)` 每次从 Project、Task、State、Ledger、Execution Events、Harness/Gate、Review、Evidence 和 Delivery 读取并交叉校验，输出内存快照：

- `project`：ID、名称、生成时间、数据完整性状态；
- `active_task`：Task、Round、生命周期、当前 step run、已运行时间、下一动作；
- `waves[]`：固定 H1～H15 的标题、工作摘要、Feature、子 Task、Heavy 收口、耗时覆盖与 Task 耗时合计；
- `tasks[]`：状态、Round、墙钟跨度、主动执行、等待、未记录、时间精度、记录覆盖率、明细覆盖率、失败/中断次数和互斥耗时构成；
- `tasks[].steps[]`：类型、Round、名称、目的、状态、开始/结束/耗时、结果、来源和 refs；
- `diagnostics[]`：事件断链、旧数据缺口、孤立事件、事实冲突和非法路径。

时间字段统一带 `precision: exact | derived | unknown` 和 `source`。总量定义：

- `wall_clock_ms`：Task 第一个可信时间到 delivered/当前时间的跨度；
- `active_ms`：所有已闭合且非 wait 步骤的区间并集，避免并行步骤重复累计；
- `waiting_ms`：所有 wait 区间并集；
- `untracked_ms`：墙钟跨度中既非 active 也非 waiting 的可计算区间；
- `round_detail_ms`：Round 内被复现、分析、修改、Harness、Gate 等子步骤覆盖的区间并集；
- `round_unattributed_ms`：Round 总跨度扣除已记录子步骤和显式等待后的剩余时间，作为埋点与执行效率缺口，不伪造归因；
- `current_elapsed_ms`：当前未闭合步骤从开始到浏览器当前时间，只有 exact start 才显示精确值。

若时间区间重叠，时间线保留每个步骤原始区间，总计使用区间并集；因此未来 Phase 4 并发不会重复计算项目主动时间。

### 旧项目重建

旧项目不强制迁移或改写已有文件。Projection Builder 通过 Adapter 读取 v1 事实：

1. Gate `duration_ms` 与 `created_at`：精确步骤耗时；
2. prepare、Provider `STARTED`、collect、Harness `updated_at`、Evidence/Review 时间：在语义可配对时生成 derived 节点；
3. Ledger Attempt：展示时间点、动作和结果，但时长为 unknown；
4. 无时间戳的 State History：展示状态顺序，不展示伪造的状态耗时；
5. 文件 mtime 只可用于诊断，不进入用户可见的耗时计算。

升级后的首次写入先追加一个 `annotation` 基线事件，声明此前数据的兼容边界；不为旧步骤批量制造假的 start/end 事件。

### 本地 Web 接口

CLI 新增：

```text
spec-loop view $PROJECT_DIR [--port $PORT] [--no-open]
spec-loop snapshot $PROJECT_DIR [--json]
```

`view` 默认绑定 `127.0.0.1` 和可用端口，只接受 GET/HEAD；`snapshot` 提供确定性 JSON，方便测试和后续 Connector 复用。HTTP 仅提供：

- `GET /`：打包在 npm 产物内的静态观察面；
- `GET /api/snapshot`：当前投影，支持 `ETag`/`If-None-Match`；
- `GET /api/projects`：枚举宿主 Project 与其 `projects/` 下合法的直接子工程，只返回 opaque key、Project ID 和名称；`GET /api/snapshot?project={project-key}` 只解析该清单中的 key，不接收文件系统路径；
- `GET /api/artifacts/:ref`：只返回白名单内可安全预览的文本摘要或图片，不允许任意路径。

### 启动即看与服务生命周期

`view` 从仅有前台命令扩展为 Project 级后台服务：

```text
spec-loop view start $PROJECT_DIR [--open|--no-open]
spec-loop view status $PROJECT_DIR
spec-loop view open $PROJECT_DIR
spec-loop view stop $PROJECT_DIR
```

控制目录保存可重建的 view runtime marker（PID、loopback URL、启动时间和 Project identity），但它不是业务事实源。每次复用前必须校验 PID 仍属于当前 Spec-Loop view、URL 仍为 loopback、Project realpath 一致且健康检查通过；失效 marker 原子替换，不能向无关进程发送信号。

`round`、`harness prepare` 和未来统一批次启动入口在交互 TTY 下调用幂等 `ensureView()`：已有健康服务则复用并打开，没有则后台启动；成功与失败都打印一行稳定的 `View: http://127.0.0.1:$PORT/`。非交互环境默认只在已有服务时打印 URL，不启动浏览器；`--no-view` 完全跳过。浏览器打开是辅助动作，失败只产生诊断，不能回滚已经成功的 Task 生命周期操作。

顶部当前工作不能只复用 `selectActiveTask()` 的生命周期更新时间排序。Projection Builder 先选择仍未闭合的执行步骤，按 `occurred_at`、项目单调 sequence 和确定性 task ID 处理并列；只有没有运行步骤时才回退 lifecycle。若存在多个未闭合步骤，返回 `active_tasks[]` 并在页面标记并发，单值 `active_task` 只作为最近活动的兼容投影。

浏览器每秒条件刷新 snapshot；当前步骤 elapsed 在前端按服务端 `generated_at` 与 step start 本地递增，不要求服务端每秒写文件。没有新增事件时返回 304。

### 页面信息架构

页面保持一个观察面、三层信息：

1. 右侧顶部固定“全局 Airflow 总览”：展示 Project 的波次总数/完成数、Task 总数、全部生命周期状态数量与占比，并保留当前实际执行波次、Task、Round、步骤、elapsed 和下一动作；该区域不随浏览波次切换而替换结构；
2. 桌面端左侧固定“H1～H15 完整波次明细”：严格按 H 顺序展示名称、状态、Task 完成度和耗时；当前实际运行波次与用户选中浏览波次分别编码，不能混为一个状态；
3. 全局总览下方只展示选中波次的概览、耗时构成、子 Task DAG/列表和当前 Task 检查器，不再重复铺开全部 H；首次进入优先选择活动 Task 所属 H，没有直接归属时按运行状态和最新未完成 H 确定浏览默认值；窄屏时波次目录折叠为顶部横向滚动卡片；
4. H 内 Task 先做传递约简，再交给本地自托管的 ELK layered 布局与 orthogonal edge routing；同列表示并行，长边自动绕开中间节点，圆角路径、节点外箭头和输入/输出端口表达方向，悬停节点时高亮关联上下游；
5. 点击左侧 H 只更新右侧波次与 Task 区域；点击 Task 同步依赖图选中态、任务列表和检查器，不切换页面；
6. Task 详情按“执行结论 → 耗时构成条 → Task→Round→活动步骤分层时间线 → 折叠数据来源”组织；时间构成使用区间切片和固定优先级互斥归类，保证并行步骤不重复累计；
7. Ant Design 波次选择器保留为键盘与窄屏辅助入口；桌面主导航以左侧领域波次列表为准，Task 详情通过“收起”回到完整同页视图，不维护页面级导航栈。
8. 顶栏使用 Ant Design 工程选择器展示宿主工程与 `projects/` 下所有合法直接子工程；切换工程时先保留上一帧并标记切换状态，新 Snapshot 到达后重置波次、Task、ELK cache 和 ETag，不能用上一工程的结构签名做增量 patch。

H 状态不直接照抄路线图：所有子 Task 均为 delivered/cancelled 才显示完成；存在 verifying 则显示验证中，存在 working/iterating 则显示进行中。路线图已完成但子 Task 未完成时输出 diagnostic 和页面冲突提示。总览默认将滚动容器定位到“活动 Task 所属 H；否则最新未完成 H；否则最后一个 H”。H 内图采用标准分层 DAG：一个依赖深度对应一层、从上到下布置，只绘制真实依赖边，不生成虚假顺序边；同层节点使用父节点重心排序并为多入/多出边分配端口。

Round 详情额外显示“明细覆盖 / Round 总耗时 / 显式等待 / 未拆分耗时”。命令行通过 `activity start/finish` 记录复现、分析和修改，通过 `activity run` 包装编译、定向测试和 Playwright；命令退出码与时间自动形成事件。历史 Round 没有子步骤事实时只显示未拆分区间，不根据提交时间或日志反推虚假明细。

耗时诊断采用确定性规则：未拆分超过墙钟跨度 20%、单个步骤超过墙钟跨度 50%、存在失败/中断、等待高于主动执行时分别给出提示。筛选只影响列表排序与 DAG 节点显著度，不移除节点和边，避免破坏依赖语义。

刷新采用上一帧保底：snapshot 请求或渲染失败时不得清空当前 DOM，只显示局部错误并继续轮询。静态资源按请求读取，避免长驻服务继续返回启动时缓存的旧 UI。

前端以稳定 revision 和结构签名划分更新边界：仅时钟推进时只原位修改 elapsed、统计数字、耗时构成条和活动节点文案；Task/H 关系或步骤结构变化时才重建对应区域。页面骨架与通用交互使用本地打包的 React 19 + Ant Design 6：外层采用 Layout、Header、Sider、Content，全局总览和波次耗时采用 Card、Statistic、Progress、Tag、Badge，左侧波次目录采用 Menu、Progress、Tag，步骤检查器采用 Timeline、Descriptions、Collapse，工程/筛选采用 Select、Button、Segmented、Tooltip、Breadcrumb、Empty、Alert；通过 `ConfigProvider.csp` nonce 兼容严格 CSP。工程切换保留上一帧并覆盖 Spin 状态，数值原位变化只触发短时低对比高亮。ELK/SVG DAG 和 Task 领域数据行继续使用领域渲染，避免把图节点错误抽象成表单按钮。

历史 Task 默认按最近活动倒序；当前 Task 固定置顶。unknown 不画成有长度的时间块，而用缺口标记；derived 使用虚线边界，避免视觉上与 exact 混淆。状态不能只靠颜色表达。

### 安全、完整性与隐私

- 固定 loopback，不接受 `--host 0.0.0.0`；不加入认证不足的远程访问模式；
- 所有磁盘入口使用 realpath、regular-file、symlink 和 Project 边界检查；
- 接口不返回绝对路径、Prompt、provider 原始 stdout/stderr、环境或 Connector 身份；
- label/summary 来自受控 step type 或写入前经过现有 Secret 检查与中央脱敏；
- HTML 使用 textContent 渲染数据，启用严格 CSP，不从外网加载脚本、字体或样式；
- 事件 hash 断链、sequence 重复、非法状态组合和权威事实冲突进入 diagnostics，严重错误阻止正常绿色状态。

### 可删除与重建边界

可以删除并重建：内存索引、HTTP ETag、可选 `.spec-loop/cache/execution-snapshot.json`、页面资源缓存。

不可作为缓存删除：`TASK_STATE.md`、`STATE_HISTORY.jsonl`、`LOOP_LEDGER.jsonl`、`EXECUTION_EVENTS.jsonl`、Harness/Gate 原生 Evidence、Review 历史和 Delivery。执行图能重建不等于所有来源都是投影；事件流是历史时间事实源。

## 方案取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 直接扫描现有文件并用 mtime 算耗时 | 无协议改动 | 结果不可靠、复制或恢复会改变 mtime | 拒绝 |
| 把 UI 数据写进 SQLite | 查询方便 | 引入第二状态源和迁移/恢复复杂度 | 拒绝作为事实源；未来可做可删索引 |
| 项目级追加事件流 + 可重建投影 | 时间事实完整、跨 Task 有全序、仍保持 UI 可重建 | 需要统一埋点与完整性校验 | 采用 |
| 为每个 Task 单独事件流 | Task 迁移方便 | 跨 Task 当前步骤和并发顺序难以确定 | 不采用首版 |
| 静态 HTML 报告 | 最简单 | 不能可靠表达运行中 elapsed 和新增步骤 | 保留为未来导出，不作为主入口 |
| 本机只读 Web 服务 | 实时、交互和跨平台浏览器体验好 | 需要端口和进程生命周期管理 | 采用 |
| 启动命令自动复用后台 view | 零记忆成本、无需占用第二终端、入口始终可发现 | 需要安全 PID/端口管理和 TTY/CI 差异 | 采用；由 TASK-029 加固 |

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| 事件写入遗漏 | 时间线出现缺口 | 所有生命周期/Harness 入口共用 writer，恢复产生显式 interruption/annotation | UI 回退既有事实并标 unknown，不影响任务执行 |
| 事件流损坏 | 错误耗时或错误完成状态 | hash chain、sequence、严格 schema、对抗测试 | 保留现场，修复或从最后可信事件继续新 segment |
| 事件与权威状态冲突 | UI 误导 | 结果以权威文件为准并显示 diagnostic | 禁用页面绿色结论，任务控制链不受影响 |
| 本地服务泄漏数据 | Prompt/Secret 暴露 | loopback、GET only、白名单字段、中央脱敏、CSP | 停止 `view`；不影响 `.spec-loop` 事实 |
| 大项目重建变慢 | 页面不可用 | 流式 JSONL、内容 hash/offset 增量索引、性能 Gate | 删除缓存后全量重建；必要时降级 snapshot CLI |
| UI 视觉复杂度过高 | 用户仍找不到当前工作 | 首屏只突出一个 active Task/step，细节按选择展开 | 回退到文本 snapshot，不改变底层协议 |

## 验证策略

| 验收标准 | 验证层级 | 方法 | 预期结果 |
|---|---|---|---|
| AC-1、AC-2 | 单元 + Playwright | 固定事件 fixture，检查当前卡片、时间泳道、步骤详情和计时 | 当前工作明确，四类时间计算正确 |
| AC-3 | E2E | 删除全部 cache/snapshot 后两次重建并比较 canonical JSON | 语义一致且没有第二状态源 |
| AC-4 | 兼容测试 | 使用当前仓库和 Phase 1–3 Dogfood 目录重建 | 旧事实展示，精度标签准确，缺失值不伪造 |
| AC-5 | 故障注入 + Playwright | 未闭合事件、进程崩溃、reconcile、新事件追加 | elapsed 更新，异常明确，增量刷新成功 |
| AC-6 | 对抗测试 | 截断、重排、改 hash、重复 sequence、symlink/path traversal | fail closed 并给出诊断 |
| AC-7 | 安全测试 | 绑定地址、HTTP 方法、Secret canary、XSS payload、任意路径 | 仅回环只读且无敏感输出 |
| AC-8 | 性能 Gate | 200×200 fixture 冷建与单事件增量 | 分别满足 2 秒和 500 毫秒门限 |
| AC-9 | Playwright + 人工 | 桌面/窄屏四条路径、截图与 revision-bound Review | 功能通过且信息层级获用户批准 |
| AC-15 | CLI 集成 + 进程对抗 | Task/Harness 启动、重复启动、僵尸 marker、CI、`--no-view`、浏览器打开失败 | 入口可点击且幂等，故障不阻断任务 |
| AC-16 | 多 Task 事件 fixture + Quant Dogfood | 旧 working Task 与新 Harness 步骤并存、多个未闭合步骤、同时间事件 | 当前工作指向真实运行步骤，并发活动完整可见 |

## 工单拆分

| 工单 | 交付物 | 依赖 | 状态 |
|---|---|---|---|
| [TASK-027](../04-task/TASK-027-execution-events.md) | 项目级事件协议、writer、全入口埋点、恢复与协议测试 | Phase 3 现有 Task/Harness | 进行中 |
| [TASK-028](../04-task/TASK-028-execution-view.md) | Projection Builder、snapshot CLI、本地服务和 Web UI | TASK-027 | 进行中 |
| [TASK-029](../04-task/TASK-029-execution-view-hardening.md) | v2 Heavy：旧数据 Adapter、安全/性能/浏览器 Gate、真实项目 Dogfood、独立 V/R | TASK-027、TASK-028 | 已批准 |
| [TASK-033](../04-task/TASK-033-pmvr-execution-observability.md) | v2 P/M/V/R、Conflict、Inbox、Candidate 事件与观察面 | TASK-027、TASK-028、TASK-032 | 已批准 |

## 实际实现

- 最终实现：`EXECUTION_EVENTS.jsonl`、Projection Builder、`snapshot`/`view` CLI、只读 HTTP 服务与自包含 Web UI 已完成首版实现。
- 与设计差异：首版仅展示安全的 Artifact/Evidence 逻辑引用，不提供 `/api/artifacts/:ref` 内容读取；旧 Harness 非 Gate 阶段暂不根据弱时间点生成 derived 区间；事件存储当前在锁内原子重写完整 JSONL，增量索引与大规模性能优化留给 TASK-029。
- 运维/迁移说明：旧项目无需迁移；启用新版本后从基线事件开始记录完整时间。
- 关联完成工单：无。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-08-12 | 创建设计 | 建立不依赖 UI 数据库、可从 `.spec-loop/` 重建的执行图 | TASK-027～029 |
| 2026-08-12 | 批准核心实现 | 用户要求优先交付可视化和耗时定位能力 | TASK-027、TASK-028 |
| 2026-08-13 | 将信息架构扩展为 H 波次、子 Task、执行步骤三级 DAG | 对齐项目 H1～H15 的真实组织方式，并补齐可逆导航 | TASK-028 |
| 2026-08-13 | 增加状态一致性派生、当前 H 自动定位和标准分层 DAG | 修正外层完成状态误导，压缩卡片并改善 H15 依赖图可读性 | TASK-028 |
| 2026-08-13 | 改为 H 折叠式单页 DAG 并执行传递约简 | 默认保持单一 H 主链；展开后并行 Task 严格同层，无需 H 二级页面 | TASK-028 |
| 2026-08-13 | 引入 ELK 分层布局与避障路由 | 跨层依赖会穿过中间节点，手工曲线无法稳定避障；ELK 只负责布局路由，节点交互继续由轻量 SVG 控制 | TASK-028 |
| 2026-08-20 | 设计 Project 级后台 view 与启动即看入口 | Quant Dogfood 表明前台 `view` 命令不够直接，Task/Harness 启动时应自动暴露可视化 | TASK-029 |
| 2026-08-20 | 使用稳定结构增量更新并统一 Ant Design 控件 | 用户反馈轮询整页闪烁、原生下拉和手写控件不一致；限定重绘边界并统一通用交互组件 | TASK-028 |
| 2026-08-31 | 改为左侧全量波次明细、右侧波次与 Task 主从工作区 | 用户需要持续看到全局波次顺序，同时理解当前波次状态、耗时和子 Task；顶部细轨与右侧全量平铺均不满足该信息层级 | TASK-028 |
| 2026-08-31 | 将右侧固定拆为全局 Airflow 总览与所选波次详情 | 全局 Task 状态和当前运行位置必须持续可见，左侧波次选择只影响下方的单波次 DAG、Task 列表和检查器 | TASK-028 |
| 2026-08-31 | 增加 `projects/` 工程目录与安全工程切换 | 同一引擎观察面需要覆盖本机多个 Project，同时保持只读、路径不可注入和逐工程 ETag/浏览状态隔离 | TASK-028 |
| 2026-08-31 | 将全局总览与波次目录升级为 Ant Design 页面组件 | 页面虽已使用 AntD 表单控件，但统计卡和波次列表仍是手写 DOM，视觉语言不统一且与 React 根存在更新冲突 | TASK-028 |
| 2026-08-31 | 页面骨架、波次指标和步骤检查器统一为 Ant Design | 第二轮视觉走查发现外层布局、耗时卡和步骤时间线仍为手写组件，且辅助字号过小；改用 Layout、Statistic、Timeline、Descriptions、Spin 并提升信息可读性 | TASK-028 |
| 2026-09-04 | 增加 v1 兼容收口与 v2 观察面桥梁 | TASK-027/028 保持在途 v1，TASK-029 使用 v2 Heavy，TASK-033 原生展示 P/M/V/R 运行事实 | TASK-027～029、033 |
