# TASK-027：执行事件协议与全入口埋点

- 状态：已完成
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-08-12
- 最后更新：2026-09-29
- 所属设计：[DES-009](../03-design/DES-009-execution-visualization.md)
- 所属特性：[FEAT-009](../02-feature/FEAT-009-execution-visualization.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-013、TASK-025
- 协议版本：v1 在途兼容收口；不得中途迁移
- 所属批次：P4-B1

## 目标

建立项目级、追加式、hash-chained 的执行事件协议，并在现有 Task 生命周期、Harness、Gate、Review、Verification、Delivery 和等待用户入口记录可配对的步骤事实，为准确重建当前步骤与耗时提供数据基础。

## 与 P/M/V/R v2 的关系

- 本工单已在 v1 Round 1 开始，按照最新版架构的兼容边界继续使用原 `TASK_STATE/VERIFY` 协议，不改写为 v2 Run。
- 当前实现是 v1 与 v2 共用的事件事实底座；本工单只收口既有 v1 step type 和入口，不在结束前追加未经批准的 v2 角色语义。
- v2 P/M/V/R、Conflict 和 Candidate 事件由 TASK-033 在 TASK-027/028 收口后接入。
- 本工单的正式验证仍需独立执行者和稳定候选，但不伪装成 TASK-030 的 v2 Candidate。

## 工作范围

### 包含

- `EXECUTION_EVENTS.jsonl` schema、类型、严格 reader/writer 和完整性校验；
- 项目级互斥、sequence、step run ID、previous/event hash 与原子追加；
- 受控 step type、label/summary、refs 和 Secret 检查；
- Task、Round、Harness、Gate、Review、Verification、Delivery 与 wait 事件埋点；
- Round 内问题复现、根因分析、代码修改和临时定向命令的显式计时入口；
- 崩溃后的未闭合步骤识别与 reconcile interruption/annotation；
- 旧 Project 首次写入的显式基线事件；
- 单元、并发、故障注入和对抗测试。

### 不包含

- Web 页面、HTTP 服务和交互时间线；
- Scheduler、自动 Controller、并发 Worker、外部 Connector 写入；
- 伪造旧 Task 的历史 start/end；
- 修改 Task State、Ledger、Evidence 和 Delivery 的权威边界。

## 实施要求

1. 事件 writer 必须是所有生产入口的唯一写入路径，reader 必须验证 schema、连续 sequence、hash chain、开始/终止配对和路径边界。
2. 业务权威操作成功但事件写入中断时，reconcile 只能追加说明事实，不能回滚或改写已经成立的 Task/Harness 结果。
3. Gate 需按单个 Gate 记录开始和结束，终止事件引用现有 Gate Result hash；Provider 执行不得保存 Prompt 正文或原始输出。
4. wait 事件必须区分用户输入、视觉 Review、正式验证授权和 Heavy 验收。
5. 事件协议必须支持未来同一 Task 多 Run 和跨 Task 并发，不假设任意时刻只有一个 step。

## 验收标准

- [x] AC-1：所有受控 step type 都能产生合法 start/terminal 配对，并可从事件计算精确耗时。
- [x] AC-2：并发追加不会产生重复 sequence、断链、丢事件或半行 JSON；异常后可安全继续或明确要求协调。
- [x] AC-3：截断、重排、篡改、重复、孤立终止、路径越界和 Secret canary 均被拒绝或明确诊断。
- [x] AC-4：现有 Task/Harness/Gate/Review/Delivery 主路径记录步骤事件，但原有权威文件和全量回归行为不变。
- [x] AC-5：崩溃产生的未闭合步骤不会被显示为成功；reconcile 追加 interruption/annotation 后形成可审计结论。
- [x] AC-6：旧 Project 首次使用只记录真实基线，不为无时间戳的历史状态制造虚假耗时。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1、AC-4 | 定向 Node 测试覆盖生命周期与 Harness 主路径 | 每个入口生成预期事件且现有状态不漂移 |
| AC-2、AC-5 | 并发进程与 hard-crash fixture | 无损追加，未闭合和恢复语义正确 |
| AC-3 | JSONL/hash/path/Secret 对抗 fixture | fail closed 且错误可定位 |
| AC-6 | 复制 Phase 1–3 Dogfood fixture 后首次写入 | 只有 baseline annotation，无伪造历史事件 |

## 验证范围

- 本 Task 使用 `coverage: targeted`，覆盖事件模块、被埋点入口及直接回归。
- 数据库使用 `persistent`/fixtures；本 Task 不需要一次性数据库。
- 整体浏览器与全量回归由 TASK-029 统一执行。

## 人工效果验收

- 是否需要：否；本 Task 不交付 UI。
- 功能边界：协议语义使用确定性测试验证。

## Web 功能验证

- 是否需要：否。

## 交付记录

- 完成日期：2026-09-29；独立 V/R 在 `e399565ce18ea7825fb0dc0c25c42f21d55946d5` 同一干净候选通过。
- 变更文件/交付物：`src/execution-events.ts`；Task、Harness、Gate、Review 入口埋点；协议/并发/篡改/崩溃定向测试
- 关键实现与决策：有 owner PID 的短步骤可识别进程退出并投影为中断；跨命令持续的 Round/wait 不绑定 PID；旧项目首次写入显式 baseline annotation。
- 与原设计的差异：writer 为追加语义、锁内原子重写完整 JSONL，而不是文件尾原地 append；这样复用现有原子事务，但大事件量优化留给 TASK-029。
- 遗留风险：200×200 性能与最终浏览器组合验收由 TASK-029 Heavy 执行；本工单全入口定向故障注入已通过。

## 验证证据

| 日期 | 验证人 | 环境 | 结果 | 证据/输出 |
|---|---|---|---|---|
| 2026-08-12 | Codex | Node 22，本地定向测试 | 通过（非正式关闭） | 相关 39 项测试通过，覆盖事件时间计算、并发 writer、篡改/Secret fail-closed 与死进程中断投影 |
| 2026-09-04 | Codex/M（快速反馈） | Node 22，P4-B1 | 14/14 通过（非正式 Evidence） | `npm run build`、`node --test test/execution-view.test.mjs`；保留一次 CLI 参数包装失败记录，正确重跑后通过 |
| 2026-09-29 | 独立 V | 干净候选 `af57702`，v1 在途定向 Gate | FAIL（AC-3/4） | `.spec-loop/output/TASK-027-V-af57702.json`；旧 `step_run_id` 重用与 Task ID Secret canary 被接受，结构化用户输入/验证授权/Heavy 等待及 `review.visual`、`task.attempt` 入口缺少生产配对事件 |
| 2026-09-29 | 独立 V | 干净候选 `02c5fe1`，AC-5 故障注入 | FAIL（AC-5） | `.spec-loop/output/TASK-027-V-02c5fe1.json`；确认权威请求已提交而事件写入中断，恢复后缺少等待事实 |
| 2026-09-29 | 独立 V | 干净候选 `e399565`，定向 AC-1～6 | PASS | `.spec-loop/output/TASK-027-V-e399565.json`；恢复故障注入、协议与生产入口均通过 |
| 2026-09-29 | 独立 R | 同一干净候选 `e399565`，定向 AC-1～6 | PASS | `.spec-loop/output/TASK-027-R-e399565.json`；权威恢复、并发、Secret、ID 重用及归档复核通过 |

## 2026-09-29 修复候选

- reader 对全事件历史保持已使用 step ID 集合，终止后重用也拒绝；writer 对 Task/Run 身份执行 Secret 检查。
- 托管确认请求记录分类的 `wait.user` 起止事件，并以 request ID 精确配对；过期、失效和候选替换以中断结束。视觉 Review 与 Attempt 主路径补上配对步骤事件。
- 构建、对抗/确认等待与受影响入口定向测试通过。权威确认请求提交后若事件写入失败，读取或终止请求会补齐真实等待起止；独立 V/R 在 `e399565` 通过。本 Task 保持 v1 在途协议，不迁移到 v2。

## 关闭检查

- [x] 验收标准全部通过
- [x] 测试/检查结果已记录
- [x] 设计差异已记录
- [x] 上游实际结果已更新
- [x] 已从两个看板移除

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-08-12 | 创建工单草案 | 为执行图补齐可靠时间事实 |
| 2026-08-12 | 开始实施 | 用户批准优先实现可视化与耗时能力 |
| 2026-08-12 | 完成核心实现和定向验证 | 保留正式全入口/性能验收后再关闭 |
| 2026-09-04 | 按最新版架构定义兼容收口 | 保持 v1 在途任务不迁移，并将 v2 事件扩展明确交给 TASK-033 |
| 2026-09-04 | 启动 P4-B1 快速反馈检查 | 构建与执行事件/视图定向测试通过；未进入正式 V/R 或 Delivery |
| 2026-09-29 | 完成 TASK-027 v1 兼容收口 | `e399565` 独立 V/R 双 PASS，AC-1～6 全通过；页面和最终 Heavy 归后续工单 |
