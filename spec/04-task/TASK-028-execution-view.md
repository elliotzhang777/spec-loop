# TASK-028：可重建投影与本地执行 Web UI

- 状态：进行中
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-08-12
- 最后更新：2026-08-20
- 所属设计：[DES-009](../03-design/DES-009-execution-visualization.md)
- 所属特性：[FEAT-009](../02-feature/FEAT-009-execution-visualization.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-027

## 目标

交付 `snapshot` 与 `view` 命令，让用户通过只读本地页面看到当前 Task/步骤、步骤目的、实时 elapsed、历史 Task 时间泳道和可展开的步骤/Evidence 明细。

## 工作范围

### 包含

- `buildExecutionSnapshot`、严格 snapshot schema 和确定性 JSON CLI；
- Task/step 区间并集、wall/active/waiting/untracked 和精度计算；
- `spec-loop snapshot <project-dir> --json`；
- loopback-only、GET/HEAD-only 的 `spec-loop view <project-dir>`；
- 打包进 npm 产物的自包含 HTML/CSS/JS；
- 首屏当前工作、Task 时间泳道、步骤详情、diagnostics 和窄屏布局；
- ETag 条件刷新、前端 current elapsed 和新增事件增量可见；
- H1～H15 单页折叠主链、横向子 Task DAG、传递约简和原位 Task 详情；
- 定向单元、HTTP、Playwright 与可访问性测试。

### 不包含

- 旧项目深度兼容和大规模性能/安全最终验收；
- 任意 Task 修改、命令执行、批准、Review 决策或 Connector 写入；
- 远程监听、账号系统和公网部署；
- Portfolio 跨 Project 聚合。

## 实施要求

1. Snapshot 的 active Task 必须复用或抽取现有 Project progress 派生规则，不得出现飞书进度和 Web 页面各自选择不同 active Task 的双实现。
2. 当前没有未闭合 step 时，页面必须明确显示“当前无执行步骤”和由生命周期派生的下一动作。
3. derived/unknown 必须在结构化数据和视觉编码中都区别于 exact；unknown 不得渲染为具有虚假长度的时间块。
4. 页面只能通过 textContent 或等价安全方式渲染项目数据，静态资源不得依赖公网 CDN。
5. Artifact 入口只允许设计白名单类型和 Project 内逻辑引用；首版可只展示 metadata，不要求直接打开原始文件。
6. UI 必须可用键盘完成 Task 选择、步骤展开和 Evidence 定位；状态同时使用文字/图形，不只依赖颜色。
7. Select、Button、Segmented、Tag、Badge、Tooltip、Breadcrumb、Empty、Alert 等通用控件必须直接使用 Ant Design；H/Task 数据卡片和 DAG/SVG 节点保留领域可视化语义，不伪装成通用按钮皮肤。

## 验收标准

- [ ] AC-1：snapshot 对同一事实输入产生 canonical 等价输出，删除任何 cache 后可以完整重建。
- [ ] AC-2：页面首屏准确显示当前 Task、Round、生命周期、当前步骤、目的、elapsed、下一动作和 freshness。
- [ ] AC-3：Task 泳道与明细准确展示 wall/active/waiting/untracked，以及每个步骤的状态、耗时、结果和 refs。
- [x] AC-3a：Round 详情展示复现、分析、修改、编译/测试等子步骤，并单独标明子步骤覆盖率与未拆分耗时。
- [ ] AC-4：新增事件后页面无需整页刷新即可在 500 毫秒目标之外的下一轮条件刷新内更新；无变化时服务返回 304；时钟推进只修改数字、进度条和节点耗时，不重建页面结构或造成控件闪烁。
- [ ] AC-5：只绑定 loopback，只接受 GET/HEAD；非法方法、路径遍历、symlink、XSS payload 和 Secret 字段不会造成写入或泄漏。
- [ ] AC-6：桌面与窄屏 Playwright 路径全部通过，并完成绑定当前 revision 截图的人工视觉 Review。
- [x] AC-7：H1～H15 可从规格重建；点击 H 查看全部子 Task，点击 Task 查看步骤，并可通过面包屑、图内按钮或工具栏逐级返回。
- [x] AC-8：默认定位最新未完成 H；H 完成状态受全部子 Task 约束，状态冲突显式告警；子 Task 使用从左到右的真实依赖分层 DAG。
- [x] AC-9：默认展示尺寸一致的 H 主链；每次原位展开一个 H，并行 Task 严格同列，冗余祖先依赖边不绘制，Task 详情可原位展开和收起。
- [x] AC-10：Task 详情提供结论、互斥耗时构成、Round 分层时间线、覆盖率、失败/中断次数、优化提示和折叠数据来源。
- [x] AC-11：Task 节点支持固定尺寸双行标题与完整悬停文本；完成态中性化；筛选不破坏 DAG 拓扑，并支持总耗时排序与当前任务定位。
- [x] AC-12：所有通用操作控件统一使用本地打包的 Ant Design 6 组件，静态页面不保留原生 `select` 或手写 Segmented，CSP 支持组件动态样式且不依赖 CDN。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1、AC-3 | projection fixture 单元测试与 cache 删除 E2E | 计算正确、重建等价 |
| AC-2、AC-4 | Playwright 当前步骤和动态追加路径 | 首屏明确，elapsed/刷新正确 |
| AC-5 | HTTP 与文件边界对抗测试 | 回环只读、无 XSS/Secret/任意文件 |
| AC-6 | 桌面与 390px Playwright + REVIEW-1 | 功能通过且视觉获用户批准 |
| AC-12 | 静态资源契约测试 + Playwright 键盘/弹层路径 | AntD 资源本地可用，无原生 select/手写 Segmented，弹层与焦点行为正确 |

## 验证范围

- 本 Task 使用 `coverage: targeted`，覆盖投影、CLI、HTTP、UI 和直接依赖。
- 数据库使用 `persistent`/fixtures；页面不引入数据库事实源。
- 全量兼容、安全和性能由 TASK-029 执行。

## 人工效果验收

- 是否需要：是；控制 Task 必须在 `ACCEPTANCE.md` 声明 `REVIEW-1` 并覆盖 AC-2、AC-3、AC-6。
- 验收范围：当前工作是否一眼可见；Task/步骤层级、时间比例、exact/derived/unknown 区分、失败与等待状态、桌面和窄屏密度。
- 功能边界：人工效果验收不替代 Playwright、可访问性、时间计算和安全 Gate。
- 证据要求：当前 revision 的桌面与窄屏 PNG，修改 UI 后重新请求。

## Web 功能验证

- 是否需要：是；控制 Task 的 `ACCEPTANCE.md.web_gates` 与 `.spec-loop/GATES.md` 必须声明相同 `execution-view-e2e` Gate。
- 功能路径：打开当前 Project、定位 active step、比较两个历史 Task、展开失败步骤、查看 Evidence metadata、新事件动态刷新、窄屏操作。
- 证据要求：JSON、HTML、桌面与窄屏截图，零 unexpected/flaky/skipped。

## 交付记录

- 完成日期：核心实现完成，待视觉与正式验收关闭
- 变更文件/交付物：`src/execution-view.ts`、`src/execution-view-server.ts`、`assets/execution-view/*`、`snapshot`/`view` CLI 与定向测试
- 关键实现与决策：每次读取 `.spec-loop` 事实重建，无 snapshot 数据库；并集计算主动/等待时间；历史缺口显式为 unknown；页面使用稳定 revision 和结构签名区分事实变化，当前 elapsed 本地递增并原位更新数字/进度；通用控件采用本地打包的 Ant Design 6，DAG 继续由 ELK + SVG 表达领域语义。
- 与原设计的差异：首版只显示 Evidence/Artifact metadata，不开放内容读取接口；真实 Playwright 和截图 Review 未在本轮执行。
- 遗留风险：当前环境没有可用浏览器会话，尚未完成桌面/390px 视觉确认、键盘路径与大规模性能 Gate，工单不关闭。

## 验证证据

| 日期 | 验证人 | 环境 | 结果 | 证据/输出 |
|---|---|---|---|---|
| 2026-08-12 | Codex | Node 22，本地定向测试 | 通过（非正式关闭） | 相关 39 项测试通过；HTTP 覆盖 loopback、GET/HEAD、ETag、CSP、非法方法/路径，静态 JS 通过语法和安全渲染检查 |
| 2026-08-20 | Codex | Node 22，本地定向反馈检查 | 通过（非正式关闭） | `npm run build`、`node --check assets/execution-view/app.js`、`node --test test/execution-view.test.mjs`；10/10 通过，覆盖稳定 revision、增量 patch、AntD 静态资源与 CSP |

## 关闭检查

- [ ] 验收标准全部通过
- [ ] 测试/检查结果已记录
- [ ] 设计差异已记录
- [ ] 上游实际结果已更新
- [ ] 已从两个看板移除

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-08-12 | 创建工单草案 | 把 `.spec-loop` 事实变成可实时理解的本地观察面 |
| 2026-08-12 | 批准实施 | 用户批准优先实现可视化与耗时能力 |
| 2026-08-12 | 开始实施 | 建立 managed Task 并进入 Round 1 |
| 2026-08-12 | 完成核心实现和定向验证 | 等待真实浏览器视觉反馈与正式加固验收 |
| 2026-08-12 | 重构运行控制台视觉与实时反馈 | 用户反馈原页面组件弱、缺少 Workflow 和运行态动效 |
| 2026-08-12 | 将线性 Stepper 重构为 Heavy Task DAG | 用户反馈方块堆叠缺少真实 Workflow 感；增加 Gate 分支、Review/Verifier 汇合、失败 Triage 与新 revision 终点 |
| 2026-08-12 | 将 DAG 调整为从上到下阅读 | 纵向主链更符合任务逐层下沉的认知顺序；Gate 左右分支后在 Verifier 汇合，底部区分交付与下一 revision |
| 2026-08-12 | 增加 Heavy Task 两级任务图与刷新保底 | 默认从目标规格重建 Heavy 及其依赖 Task DAG，点击节点下钻步骤 DAG；刷新失败保留上一帧并显示局部错误 |
| 2026-08-12 | 增加目标规格兼容投影与显式返回入口 | `.spec-loop` 缺失但目标规格存在的 H14/H15 Task 仍进入 Heavy DAG，并标记“仅规格记录/耗时未知”；步骤页增加图内返回按钮 |
| 2026-08-13 | 升级为 H1～H15 / 子 Task / 步骤三级 DAG | 默认展示完整波次总览；H14/H15 分别显示 TASK-136/TASK-140 收口；导航支持逐级返回，历史缺时仍明确为待采集 |
| 2026-08-13 | 压缩波次节点并修正 H15 状态与内部 DAG | 总览自动定位当前 H，顶部增加整体概述；以子 Task 状态阻止错误绿色完成，依赖图改为单深度单层和多边端口布局 |
| 2026-08-13 | 将 H 二级页合并为单页折叠主链 | 默认仅展示 H1→H15；点击一个 H 原位展开横向 Task DAG，同列代表并行，传递约简去除回勾冗余线 |
| 2026-08-13 | 使用 ELK 重做 Task DAG 路由 | layered + orthogonal routing 自动绕开中间节点；配合圆角线、节点外箭头、端口、悬停高亮和运行边流动动画 |
| 2026-08-13 | 增加 Round 内细粒度耗时与覆盖率 | TASK-141 暴露“实现 31 分钟、验证 37ms”的粗粒度误导；新增 activity 计时和未拆分时间提示 |
| 2026-08-15 | 重构 Task 耗时分析面板 | 增加结论区、互斥耗时构成、Round 分层时间线、确定性优化提示、诊断筛选和中性完成态 |
| 2026-08-20 | 改为稳定结构的局部实时更新 | 用户反馈轮询时整页元素闪烁；时钟变化只原位更新数字、进度条和节点耗时，结构变化才重绘 |
| 2026-08-20 | 通用交互控件统一为 Ant Design 6 | 用户指出原生下拉和手写组件视觉、弹层与交互不一致；保留领域 DAG，替换通用控件 |
