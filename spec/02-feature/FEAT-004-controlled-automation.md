# FEAT-004：批准后的受控自动闭环

- 状态：已完成
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-10-02
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
6. 既有单任务流程保留 M/V/R 共用语义返工预算：初次执行后最多返工 2 次。新启动的完整波次另受更严格的波次上限约束：初验加一次集中修复后的复验，最多两轮验证；工具/环境仍受有界重试预算约束，不得借重试形成第三轮波次验证。
7. V/R 重试必须产生新证据；相同失败指纹重复时可以提前停止。
8. 返工预算耗尽进入 `waiting_human_review`，生成权威 Conflict Record 和可重建 Review Inbox，禁止进入 Candidate。
9. 人可改规格并重新批准预算、换技术方案、拆分任务、显式非关键豁免、标记外部阻塞或取消；豁免会形成新契约版本并重新走 V/R，安全、隐私和关键风险不得豁免。
10. v1 运行中任务固定使用旧协议；v2 只由显式新建验收运行启用，避免升级时破坏在途任务。

## 验收标准

- AC-1：P 的批准工件完整覆盖 AC、用例、工具、断言和证据要求，内容变化或批准失效时 M/V/R 均不能继续。
- AC-2：M 的稳定 HEAD 可编译为绑定 contract/HEAD/diff/toolchain/environment 的执行计划，计划不能缩减契约覆盖。
- AC-3：V 与 R 使用独立 invocation 和独立证据目录；只有 V PASS 且 R PASS 才产生 Candidate。
- AC-4：实现、证据、工具环境、规格和高风险失败按规则路由；返工与基础设施重试预算分离。
- AC-5：旧单任务流程的 M/V/R 共享最多 2 次语义返工；新完整波次最多一轮集中返工。M 重试要求新 HEAD，V/R 重试要求新证据，重复失败指纹可提前熔断。
- AC-6：预算耗尽或规格/高风险冲突生成 Conflict Record 和 Review Inbox，状态为 `waiting_human_review` 且不能成为 Candidate。
- AC-7：普通独立冲突可暂挂且不阻塞无依赖 Ready Task；下游、关键路径和高风险任务按依赖与风险阻塞。
- AC-8：v1 在途 Task 和已启动的 `dist` 服务不因安装 v2 代码自动迁移或重启。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-004 受控自动 Controller](../03-design/DES-004-controlled-automation-controller.md) | 进行中 |
| Task | [TASK-030 P/M/V/R 验收闭环内核](../04-task/TASK-030-pmvr-acceptance-loop.md) | 已完成 |
| Task | [TASK-031 v2 验收契约接入](../04-task/TASK-031-v2-contract-onboarding.md) | 已完成 |
| Task | [TASK-032 P/M/V/R 隔离角色编排](../04-task/TASK-032-pmvr-role-orchestration.md) | 已完成 |
| Task | [TASK-039 目标 Task 文件名解析兼容](../04-task/TASK-039-target-task-filename-resolution.md) | 已完成 |
| Task | [TASK-040 M 工作树 Git 管理目录沙箱授权](../04-task/TASK-040-m-worktree-git-admin-sandbox.md) | 已完成 |
| Task | [TASK-041 候选质量兼容示例配置与 CRLF](../04-task/TASK-041-candidate-quality-portable-files.md) | 已完成 |
| Task | [TASK-042 v2 Controlled V 自动冻结候选](../04-task/TASK-042-v2-controlled-v-harness-freeze.md) | 已完成 |
| Task | [TASK-043 仓库 Bash Gate 精确授权](../04-task/TASK-043-approved-repository-bash-gates.md) | 已完成 |
| Task | [TASK-045 Proposal 领域术语误判缺陷](../04-task/TASK-045-proposal-unknown-domain-term.md) | 已完成 |
| Task | [TASK-049 受管 Gate 失败指纹误合并](../04-task/TASK-049-controlled-gate-failure-fingerprint.md) | 已完成 |
| Task | [TASK-050 M 提交前 Contract 依赖修订](../04-task/TASK-050-unstarted-v2-contract-correction.md) | 已完成 |
| Task | [TASK-051 Proposal 内嵌占位缺陷](../04-task/TASK-051-embedded-proposal-placeholders.md) | 已完成 |
| Task | [TASK-052 失败数字身份与顺序稳定性](../04-task/TASK-052-controlled-gate-fingerprint-identity-order.md) | 已完成 |
| Task | [TASK-037 Phase 4 最终 Heavy](../04-task/TASK-037-phase4-pmvr-heavy-dogfood.md) | 已完成 |

## 实际交付

- 已实现行为：TASK-030 已完成 v2 旁路协议、P Contract 前移、稳定 HEAD/计划绑定、V/R 路由、预算、Conflict/Inbox 与调度门禁；待在途 v1 Task 结束后再决定默认切换。
- 验证结论：TASK-030/031/032 在 `af57702` 上重新绑定独立 V/R 均 PASS。角色编排 20/20、直接依赖 34/34，准备/运行沙箱对抗与真实 Codex 探针通过；最终 Phase 4 Heavy 与真实业务角色仍属后续工单。
- TASK-039 的目标规格文件名解析在 `eca847d` 独立 Light V/R PASS，海工真实目录无同 ID 重复规格。
- TASK-040 的 M linked-worktree Git 最小管理目录写根在 `eca847d` 独立 Light V/R PASS；逃逸拒绝与 V/R Evidence 隔离保持。
- TASK-041 的候选文件名策略与 CRLF 空白检查在 `eca847d` 独立 Light V/R PASS；真实环境/私钥与尾随空格继续拒绝。
- TASK-042 的 Controlled V 自动冻结干净候选在 `eca847d` 独立 Light V/R PASS；HEAD、Workspace、内容指纹与 collect Evidence 持续绑定。
- TASK-043 的仓库 Bash Gate 在 `4366ed8` 独立 Light V/R PASS；命令、完整 P 契约、当前 Run、脚本真实路径及可信解释器/PATH 均在 Gate 前约束。真实业务 Gate 和最终 Phase 4 Heavy 另按对应工单验收。
- TASK-045/051 的 Proposal 校验在 `8ed8b89` 通过定向 Gate 和独立 V/R；TASK-050 的 P Contract 依赖修订在 `b25019b` 通过定向 Gate 和独立 V/R，并将实际 TASK-045 修订至版本 2、报告型缺失数降至 0。TASK-049 在 `b587ed0` 通过定向 Gate 和独立 V/R，失败指纹保留用例数字身份并忽略 TAP 顺序；TASK-052 在集成 `c45dea6` 全量质量 326/326 后关闭。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 加入 Approval 与自动 Controller | 最终 Roadmap 定稿 | - |
| 2026-08-31 | 重构为 P 预制契约、M 实现、V 独立验收、R 独立复核的四段式闭环 | 避免实现者自验收，并把失败路由、证据和返工预算变成引擎事实 | TASK-030 |
| 2026-09-04 | 拆分新任务默认 v2、角色编排与 Phase 4 Heavy | 把架构图中的状态机、实际 invocation 和最终验收分开实施 | TASK-031、TASK-032、TASK-037 |
| 2026-09-29 | 完成目标 Task 文件名兼容验收 | TASK-039 的带名称文件采用、歧义拒绝与海工 live 目录独立 V/R PASS | TASK-039 |
| 2026-09-29 | 完成 M 工作树 Git 写根边界验收 | TASK-040 独立 V/R PASS；真实 linked worktree 与逃逸对抗检查通过 | TASK-040 |
| 2026-09-29 | 完成候选质量兼容验收 | TASK-041 独立 V/R PASS；同 HEAD 定向长测试复用，未放宽敏感文件拒绝 | TASK-041 |
| 2026-09-29 | 完成 Controlled V 自动冻结验收 | TASK-042 独立 V/R PASS；脏树、候选漂移与旧未完成 Harness 阶段拒绝 | TASK-042 |
| 2026-09-29 | 完成仓库 Bash Gate 精确授权验收 | TASK-043 独立 V/R PASS；伪契约、自洽但脱离 Run 的契约及 PATH 假程序均拒绝或隔离 | TASK-043 |

## 2026-10-01 第九轮技术验收同步

TASK-054 已批准工单导入与 TASK-058 Standard/Heavy 无人工介入 Dogfood 完成；TASK-037 当前候选 8/8 Gate、独立 V/R PASS，用户最终 Heavy/Phase 4 阶段决定待办。见[第九轮完整矩阵](../05-delivery/2026-10-01-Phase4-第九轮完整测试矩阵.md)。

## 2026-10-02 最终验收同步

TASK-037 当前 `2ebee82` 候选 8/8 Gate、真实 Standard/Heavy Dogfood、独立 V/R、视觉 Review 与用户最终 Heavy/Phase 4 验收通过；FEAT-004 已完成。 见[最终人工验收记录](../05-delivery/2026-10-02-Phase4-最终人工验收记录.md)。
