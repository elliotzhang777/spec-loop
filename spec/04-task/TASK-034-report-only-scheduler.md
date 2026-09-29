# TASK-034：Report-only Scheduler

- 状态：已完成
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-09-29
- 所属设计：[DES-005](../03-design/DES-005-scheduling-worktree-coordination.md)
- 所属特性：[FEAT-005](../02-feature/FEAT-005-scheduling-isolation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-032
- 任务等级：Standard
- 协议版本：P/M/V/R v2
- 所属批次：P4-B3

## 目标

以只报告、不创建 Task、不执行 Agent 的方式周期扫描 Project，输出可重建的候选、重复项、风险、成本和 Ready/blocked 原因，为自动调度积累可靠基线。

## 工作范围

包括幂等扫描、cursor、报告、建议去重、风险/成本指标、误报和采纳统计；不包含 Task 创建、代码修改、M/V/R 启动或任何外部写入。

## 验收标准

- [x] AC-1：重复扫描同一事实产生 canonical 等价报告且不创建或修改 Task。
- [x] AC-2：每项建议包含来源、去重键、依赖、风险、预估成本和可解释的 Ready/blocked 原因。
- [x] AC-3：可统计建议量、重复率、误报、采纳率、扫描耗时和缺失数据。
- [x] AC-4：Pause、过期 cursor、损坏输入和并发扫描均 fail closed 或安全恢复。
- [x] AC-5：报告不包含 Secret、Prompt 原文或跨 Project 私有数据。

## P/M/V/R 职责与验证范围

P 冻结报告契约；M 实现；V 用多 Project Fixture 验证幂等、安全和指标；R 复核 Evidence。使用 `scope_kind: task`、`coverage: targeted`、`persistent/fixtures`。

## 实现与快速反馈记录

- 新增 `scheduler init/report/status/pause/resume`，只写 Scheduler 配置、cursor 和报告，不创建或改写 Task。
- 报告按项目/任务事实生成稳定 dedupe key、依赖、风险、成本、Ready/blocked 原因与 canonical hash。
- 指标覆盖建议量、重复率、采纳率、误报和缺失数据；反馈使用独立 `SCHEDULER_FEEDBACK.json`。
- 并发 scan、Pause、损坏/跨 Project cursor 均 fail closed；过期 cursor 自动执行 full scan。
- 2026-09-04 快速反馈：编译通过；`test/report-scheduler.test.mjs` 1/1 通过。尚未执行正式独立 V/R。
- 2026-09-28 真实项目复查：原 `missing_data` 错把 Dashboard 20 步历史截断提示计作缺失，海工项目误报 43 项；修复后只统计建议分类所需的缺失来源事实。Ready 判断也核对当前波次 Review hold 与未摄入/未终结的角色 invocation，不再把这些 Task 当作可派发。首次复查海工报告 62 项、Ready 3、`missing_data=0`；随后这 3 项推进至 Candidate，最新扫描 Ready 0、阻塞 62，与执行规划一致，连续两次扫描 canonical hash 相同。Pause/Resume 与扫描改用同一互斥，控制切换返回后不会再由旧扫描发布报告；构建和定向回归 1/1 通过。当前没有人工反馈样本，`adoption_rate=null`，本工单仍待独立 V/R。
- 2026-09-28 定向夹具补齐第二个 Project、过期 cursor、跨 Project cursor 和含额外私有字段的反馈拒绝；`test/report-scheduler.test.mjs` 1/1 PASS。此测试覆盖报告边界，不代替独立 V/R 对所有 AC 的复核。
- 2026-09-28 独立 V 对候选 `fcb715d` 判定 FAIL：非法依赖原文泄漏到报告（AC-4/5），重复或冲突反馈抬高采纳数（AC-3），证据 `.spec-loop/output/TASK-034-V-fcb715d.json`。已在 M 中修复：v2 Task、运行阶段和依赖在投影前校验；未知跨 Project 依赖只输出通用阻塞原因，损坏来源计入 `missing_data`；反馈键重复时拒绝发布。新增对抗回归，`report-scheduler` 2/2、`project` 6/6、构建通过，海工只报告扫描通过。新候选仍需独立 V 复验，V PASS 后才进行 R。
- 2026-09-28 第二轮独立 V 对干净候选 `6890a68` 判定 FAIL，证据 `.spec-loop/output/TASK-034-V-6890a68.json`：上轮的非法依赖泄漏、重复反馈均已修复，AC-1/2/3 PASS，构建和定向测试 8/8 PASS；但损坏的 Wave Review hold 可以将未校验的 `wave_id` 原文写入报告 `reason`，`missing_data` 仍为 0，AC-4/5 FAIL。未启动 R。整波两轮验证预算已用完，按看板规则退回进行中并停止自动返工/复验；下一次如获预算扩展，应校验 hold 身份、字段与绑定，并以固定通用原因报告等待状态，增加损坏 hold 的回归后再绑定新候选 V/R。
- 用户批准额外一次修复及 V/R 后，已在 M 中校验 hold 格式、Task 身份和 Review Bundle 绑定；损坏或伪造的 hold 拒绝扫描且保留已发布报告。合法 hold 的报告原因改为固定文本，避免 `wave_id` 被复制到报告和调度计划。构建通过；报告调度器 3/3、执行视图投影 1/1、波次 Review 直接依赖 2/2 PASS。新候选待独立 V，V PASS 才启动 R。
- 额外第三轮独立 V 对干净候选 `e03bd9a` 判定 FAIL，证据 `.spec-loop/output/TASK-034-V-e03bd9a.json`。常规定向测试 7/7 PASS，AC-1/3/5 PASS；但把真实待审 hold 单独伪造成格式合法的 `released` + 随机 `decision_id` 时，Reader 未核对 Review 决定便返回无 hold，报告从 blocked 误变为 Ready 且覆盖旧报告，AC-2/4 FAIL。R 未启动，本次追加轮次已用完。下次修复必须在解除 hold 前验证 Review 状态、decision ID 与该 Task 的决定，并为伪造终态增加回归；工单退回进行中。
- 2026-09-29 用户明确要求连续修复和复验。M 为终态 hold 增加 Review Bundle、`reviewed` 状态、`decision_id`、已应用 Task 及 `accept`/`return_to_m`/`continue` 动作绑定校验；伪造终态 fail closed，不覆盖报告。回归增加“待审 Review 伪造 `released`”场景；构建、报告测试 3/3、执行视图投影 1/1、Review 刷新与实际决定流程 2/2 PASS。新候选仍待独立 V，V PASS 后进入 R。
- 独立 V 对 `8ba3856` 判定 FAIL，证据 `.spec-loop/output/TASK-034-V-8ba3856.json`：报告入口拒绝伪造释放，但新 Review 创建入口仍直接读取同一原始 hold，允许覆盖未决定的旧 Review，AC-4 未过。已把 Review 创建和刷新中的原始 hold 读取统一接入绑定校验，新增伪造释放不能接管 Review 的回归；构建、报告测试 3/3、实际 Review 流程 2/2 PASS，新候选待独立复验。
- 干净候选 `cbc1a5d4f8d531a2a814af1a1a3bd50489c2f73c` 的独立 V、R 均 PASS，分别见 `.spec-loop/output/TASK-034-V-cbc1a5d.json` 与 `.spec-loop/output/TASK-034-R-cbc1a5d.json`。AC-1～5 全通过；R 绑定 V 文件 SHA-256 并重跑对抗探针与报告/Project 定向测试 9/9。报告只写 cursor/report，合法 Review 释放和暂缓可继续，伪造终态在扫描、Review 创建和刷新入口均 fail closed。候选 Git 干净；实现与 DES-005 无偏差。TASK-034 完成，TASK-035 的 report-only 稳定依赖已满足；Phase 4 最终 Heavy 仍另行验收。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 创建并批准 | 遵循路线图“先报告后执行”，不直接开启自动修改 |
| 2026-09-04 | 实现候选进入待验证 | canonical report、cursor、质量指标与只报告边界完成 |
