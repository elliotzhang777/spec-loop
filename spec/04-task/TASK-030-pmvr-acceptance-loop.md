# TASK-030：P/M/V/R 验收闭环内核

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-08-31
- 最后更新：2026-09-29
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 任务等级：Heavy
- 依赖工单：TASK-013、TASK-019；与进行中的 TASK-027/028 采用 v1/v2 双轨隔离
- 协议版本：P/M/V/R v2
- 所属批次：P4-B1

## 目标

新增不破坏 v1 在途任务的 v2 P/M/V/R 验收运行内核，使 P 的批准契约、M 的稳定 HEAD、V 的独立验收、R 的独立复核、共享返工预算和人工冲突成为可验证的引擎事实。

## 批次边界

- 项目批准入口变更后的最终候选 `7177a72` 已重新通过独立 V/R。
- 2026-09-26 起按根目录执行约定：已批准工单范围内的定向正式 V/R 随执行授权连续推进；本工单仍不自动升级为最终 Heavy Delivery、全量 Gate 或合并/发布。
- TASK-030 已在 `7177a72` 重新通过独立 V/R，TASK-031 的依赖条件满足。

## 工作范围

### 包含

- v2 验收契约、执行计划、运行态、V/R 结果、Conflict Record 和 Review Inbox Schema；
- 稳定 HEAD、diff/worktree、toolchain、environment 和 Evidence hash 绑定；
- V/R 失败分类与 M/V/人工路由；
- 最多 2 次共享语义返工、独立基础设施重试和重复失败指纹熔断；
- Candidate 门禁、人工动作与 Ready/blocked 调度投影；
- CLI 和定向对抗测试；
- v1 在途 Task 不迁移、旧命令不变、现有 dist 进程不自动重启。

### 不包含

- 自动切换所有旧 Task 的默认协议；
- 自动 merge/push/deploy；
- 未经用户批准启动真实 Heavy 验收、完整回归或当前 TASK-027/028 的 Delivery；
- 本工单内完成所有 Provider 的真实多 Agent Dogfood。

## 实施要求

1. 新 Run 必须显式启用并绑定已批准的 v2 Contract。
2. M 是候选唯一写角色，V/R 结果必须来自不同 invocation；R 不得代替 V 执行测试。
3. 执行计划必须完整覆盖全部 AC，不能弱化契约断言或证据要求。
4. 所有状态迁移使用原子写，Conflict 是权威事实，Inbox 是可重建投影。
5. 当前仓库的 v1 Task 和可视化未提交改动必须保留。

## 验收标准

- [x] AC-1：完整 v2 Contract 获人批准后才能开始；篡改内容或失效批准会被拒绝。
- [x] AC-2：M 提交稳定 HEAD 后，执行计划绑定 contract、HEAD、diff、toolchain 和 environment，并完整覆盖每个 AC。
- [x] AC-3：V 结果绑定当前计划和新 Evidence；只有 V PASS 才允许 R。
- [x] AC-4：R 与 V invocation 分离，R PASS 经过证据门禁后才产生 Candidate。
- [x] AC-5：实现、证据、工具环境、规格和高风险失败按设计路由，M 重试要求新 HEAD，V/R 重试要求新证据。
- [x] AC-6：初次执行后最多 2 次共享语义返工，基础设施重试单独有界，相同失败指纹重复可提前停止。
- [x] AC-7：预算耗尽或人工类冲突进入 waiting_human_review，生成 Conflict 和 Inbox，不能进入 Candidate。
- [x] AC-8：普通独立 Task 可暂挂且其他 Ready Task 可继续；依赖下游、关键路径和高风险任务正确阻塞或立即升级。
- [x] AC-9：人工六类处理动作受 Schema 和安全豁免规则约束。
- [x] AC-10：TASK-027/028 等 v1 在途状态无需迁移，旧 CLI/build 行为保持兼容。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1～AC-9 | `node --test test/acceptance-loop.test.mjs` | 状态机、预算、路由、存证和调度对抗用例通过 |
| AC-2～AC-4 | fixture Git repo + Gate/Artifact hash 校验 | HEAD/计划/Evidence 篡改或过期全部拒绝 |
| AC-10 | `npm run build` 与既有生命周期定向测试 | TypeScript 构建通过，v1 fixture 仍可读取 |

## 验证范围

- `coverage: targeted`，只运行本工单新增状态机、CLI 和直接受影响模块测试。
- 不运行项目全量 Gate，不迁移或结束正在执行的任务。

## 人工效果验收

- 是否需要：否。本工单是引擎协议，不修改视觉页面。

## 交付记录

- 完成日期：2026-08-31（M 实现与自测完成，等待独立 V/R）
- 变更文件/交付物：`src/acceptance-loop.ts`、v2 CLI、Proposal/Task 契约前移、规格与 7 个定向对抗测试
- 关键实现与决策：v2 旁路协议优先；P Contract 随 Proposal 一起批准；默认切换另行授权
- 与原设计的差异：将原 Checker/Judge 明确拆为 V/R，基础设施预算不占语义返工
- 遗留风险：真实多 Provider 隔离 Dogfood 留待后续 Heavy

## 验证证据

| 日期 | 验证人 | 环境 | 结果 | 证据/输出 |
|---|---|---|---|---|
| 2026-08-31 | M/Codex（非独立 V/R） | Node 22，本地临时 Git/Worktree fixture | 自测 PASS | `npm run build`；`node --test test/acceptance-loop.test.mjs`：7/7；v1 `project.test.mjs + e2e.test.mjs`：9/9 |
| 2026-09-29 | 独立 V | 干净候选 `cbc1a5d`，定向夹具 | FAIL（AC-7/9） | `.spec-loop/output/TASK-030-V-cbc1a5d.json`；常规 36/36 PASS，但对抗夹具复现豁免弱化受保护 AC、取消后幽灵 Inbox、退回 M 后陈旧 Inbox |
| 2026-09-29 | 独立 V | 干净候选 `5bc623d`，定向夹具 | PASS（AC-1～10） | `.spec-loop/output/TASK-030-V-5bc623d.json`；构建、38/38 定向测试及补充对抗复现通过 |
| 2026-09-29 | 独立 R | 干净候选 `5bc623d`，定向复核 | FAIL（AC-9） | `.spec-loop/output/TASK-030-R-5bc623d.json`；中间非关键 AC 的合法豁免被初版连续编号规则拒绝 |
| 2026-09-29 | 独立 V | 干净候选 `eb05e92`，定向夹具 | PASS（AC-1～10） | `.spec-loop/output/TASK-030-V-eb05e92.json`；构建、40/40 定向测试、7/7 独立 Schema 对抗检查通过 |
| 2026-09-29 | 独立 R | 干净候选 `eb05e92`，定向复核 | PASS（AC-1～10） | `.spec-loop/output/TASK-030-R-eb05e92.json`；5/5 关键测试和 Evidence/hash/中间 AC 豁免复核通过 |
| 2026-09-29 | 独立 V | 干净候选 `aba8744`，直接依赖重绑 | FAIL（AC-1） | `.spec-loop/output/TASK-030-V-aba8744.json`；批准 JSON 与同目录摘要一并改写后，旧批准可启动 Run |
| 2026-09-29 | 独立 V/R | 干净候选 `7177a72`，定向重绑 | PASS（AC-1～10） | `.spec-loop/output/TASK-030-V-7177a72.json`、`.spec-loop/output/TASK-030-R-7177a72.json`；构建、合并定向 52/52、R 6/6 及批准对抗复验通过 |
| 2026-09-29 | 独立 V/R | 干净候选 `7233571`，直接依赖重绑 | PASS（AC-1～10） | `.spec-loop/output/TASK-030-V-7233571.json`、`.spec-loop/output/TASK-030-R-7233571.json` |
| 2026-09-29 | 独立 V/R | 干净候选 `af57702`，直接依赖重绑 | PASS（AC-1～10） | `.spec-loop/output/TASK-030-V-af57702.json`、`.spec-loop/output/TASK-030-R-af57702.json` |

2026-09-29 M 已集中修复上述三个缺口：`waive_noncritical` 的替换契约只能移除明确豁免的 AC 与相关覆盖，其他 criteria、依赖、风险、工具、断言、证据和预算必须保持；取消时原子结清活动 Conflict，退回 M 后重建 Inbox。

独立 R 的 AC-9 缺口已修复：初版契约要求连续编号，修订契约允许豁免造成的稳定编号空洞，仍校验唯一、顺序及全量覆盖；豁免操作仍逐字段比对非豁免内容。后续批准入口的 AC-1 回归已通过本机私有密钥修复并在 `7177a72` 独立 V/R 复验。最终 Phase 4 Heavy 和真实业务角色属后续工单。

## 关闭检查

- [x] 验收标准全部通过
- [x] 测试/检查结果已记录
- [x] 设计差异已记录
- [x] 上游实际结果已更新
- [x] 已从两个看板移除

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-08-31 | 创建工单并开始实施 | 用户批准按新 P/M/V/R 流程重构引擎 |
| 2026-08-31 | 完成 v2 旁路内核与定向自测，转待验证 | 不以实现者自测替代独立 V/R |
| 2026-09-04 | 纳入 P4-B1 | 与 TASK-027/028 的 v1 兼容收口并行准备，保留正式 V/R 授权边界 |
| 2026-09-29 | `eb05e92` 独立 V/R PASS 并关闭 | 修复中间 AC 豁免编号冲突，逐项验收通过 |
| 2026-09-29 | `7177a72` 独立 V/R 重绑 PASS | 批准入口改动后关闭 AC-1 回归 |
