# FEAT-004：批准后的受控自动闭环

- 状态：进行中
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-08-31
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 所属阶段：Phase 4

## 用户价值

作为任务提交者，我希望批准 Proposal 后，系统能自动计划、开发、验证、迭代和验收，只在歧义、高风险或熔断时找我。

## 行为说明

P 在创建规格和 Task 时同步形成验收契约并等待人批准；批准后，确定性 Controller 编排 M、V、R 三个物理隔离的角色。M 提交稳定 HEAD，V 根据契约、HEAD、diff 和项目工具执行独立验收，R 只复核 V 的结论与证据。Scheduling 对普通独立 Task 允许暂挂并继续其他 Ready Task，对关键路径和高风险冲突立即转人工。

## 业务规则

1. P 的 Approval 绑定规格、AC、用例、工具、断言、证据要求、风险、批准人和内容 hash；批准后执行计划只能实例化契约，不能降低验收语义。
2. M 只能修改候选 Worktree，并在提交稳定 HEAD 和自测证据后结束；M 返工必须产生新 HEAD。
3. V 独立读取候选并使用 Playwright、API、单测等工具验收；V 证据绑定 contract hash、HEAD、diff hash、toolchain 和 environment。
4. 只有 V 通过才能进入 R。R 不修改实现、不替 V 重跑验收，只独立复核 V 的结论、覆盖和证据链。
5. V 失败分类为实现问题、工具/环境问题、规格歧义或高风险；R 失败分类为实现问题、证据问题或规格问题，并分别路由到 M、V 或人工。
6. M/V/R 共用语义返工预算：初次执行后最多返工 2 次。工具/环境采用单独有界重试预算，不消耗语义返工预算。
7. V/R 重试必须产生新证据；相同失败指纹重复时可以提前停止。
8. 返工预算耗尽进入 `waiting_human_review`，生成权威 Conflict Record 和可重建 Review Inbox，禁止进入 Candidate。
9. 人可改规格并重新批准预算、换技术方案、拆分任务、显式非关键豁免、标记外部阻塞或取消；豁免会形成新契约版本并重新走 V/R，安全、隐私和关键风险不得豁免。
10. v1 运行中任务固定使用旧协议；v2 只由显式新建验收运行启用，避免升级时破坏在途任务。

## 验收标准

- AC-1：P 的批准工件完整覆盖 AC、用例、工具、断言和证据要求，内容变化或批准失效时 M/V/R 均不能继续。
- AC-2：M 的稳定 HEAD 可编译为绑定 contract/HEAD/diff/toolchain/environment 的执行计划，计划不能缩减契约覆盖。
- AC-3：V 与 R 使用独立 invocation 和独立证据目录；只有 V PASS 且 R PASS 才产生 Candidate。
- AC-4：实现、证据、工具环境、规格和高风险失败按规则路由；返工与基础设施重试预算分离。
- AC-5：M/V/R 共享最多 2 次语义返工，M 重试要求新 HEAD，V/R 重试要求新证据，重复失败指纹可提前熔断。
- AC-6：预算耗尽或规格/高风险冲突生成 Conflict Record 和 Review Inbox，状态为 `waiting_human_review` 且不能成为 Candidate。
- AC-7：普通独立冲突可暂挂且不阻塞无依赖 Ready Task；下游、关键路径和高风险任务按依赖与风险阻塞。
- AC-8：v1 在途 Task 和已启动的 `dist` 服务不因安装 v2 代码自动迁移或重启。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-004 受控自动 Controller](../03-design/DES-004-controlled-automation-controller.md) | 进行中 |
| Task | [TASK-030 P/M/V/R 验收闭环内核](../04-task/TASK-030-pmvr-acceptance-loop.md) | 进行中 |

## 实际交付

- 已实现行为：TASK-030 已完成 v2 旁路协议、P Contract 前移、稳定 HEAD/计划绑定、V/R 路由、预算、Conflict/Inbox 与调度门禁；待在途 v1 Task 结束后再决定默认切换。
- 验证结论：M 侧构建与 7 个 v2 对抗测试、9 个 v1 兼容测试通过；尚未执行独立 V/R 或最终 Heavy，不形成正式 Candidate。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 加入 Approval 与自动 Controller | 最终 Roadmap 定稿 | - |
| 2026-08-31 | 重构为 P 预制契约、M 实现、V 独立验收、R 独立复核的四段式闭环 | 避免实现者自验收，并把失败路由、证据和返工预算变成引擎事实 | TASK-030 |
