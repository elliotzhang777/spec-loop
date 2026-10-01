# TASK-056：重跑 Gate 会覆写历史测试证据

- 状态：已完成
- 风险等级：standard
- Spec-Loop Task：.spec-loop/tasks/task-056
- Proposal：PROP-25
- 协议版本：P/M/V/R v2
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-10-01
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 来源轮次：第九轮 TASK-029 重跑完整 Heavy Gate
- 关联工单：TASK-029、TASK-037、TASK-055

## 问题与证据

`src/execution.ts` 的命令 Gate 将每次输出写入固定的 `.spec-loop/output/{task}-gate-{gate}.txt`，Playwright Gate 将报告写入固定的 `{task}-web-{gate}` 目录并在运行前删除该目录；汇总也覆盖固定的 `{task}-gates.json`。TASK-029 初次全量 Gate 的 325/326 FAIL 被再次运行后的 326/326 PASS 原始日志覆盖。初次失败的受管 V 判定和 Conflict 仍在，但原始失败日志已无法按当时记录读取；[TASK-055](TASK-055-supervisor-timeout-recovery-test-circuit.md) 中“原始完整日志保留”的描述必须修正。不能以这份已被覆盖的日志作为旧失败的原始证据。

## 验收标准

- [x] AC-1：同一 Task/Gate 再次执行时，命令 Gate 的原始输出路径唯一，旧文件内容与哈希保持不变；当前 Gate 引用新文件。
- [x] AC-2：Playwright Gate 再次执行时使用独立目录，不清除旧报告、截图与 manifest；两个运行的证据均可定位和校验。
- [x] AC-3：每次 Gate 汇总保存不可覆写的运行快照，并维持现有最新汇总读取接口；定向回归及最终完整适用矩阵通过。

## 交付范围

对每轮 Gate 生成唯一运行标识，命令输出、Playwright 目录和汇总快照都绑定该标识。现有最新汇总仅作为活动运行入口；历史证据引用快照。增加重复运行的回归验证。修正 TASK-055 的历史证据描述，不伪造丢失的日志。

## 最终裁决

候选 `ce8ebfe046b957987a0e6cee4322fe2f252aa6d6` 的受控定向 Gate 2/2、独立 V/R PASS；受管 Stage 为 Candidate。两次 TASK-037 受控全量运行分别保留唯一 ID `139ec0e2-20db-41f6-bdac-73b6d4342d10`、`fa2df8c3-c6b3-48ce-b83a-7a1eb8b1e7dd` 的原始 Gate 输出，后者 8/8、Node 334/334、独立 V/R PASS。TASK-056 首次 R 指出完整矩阵未绑定 V，已保留 FAIL 并补入新 V 后复审 PASS。Evidence 见 `.spec-loop/output/TASK-056-gates.json`、`.spec-loop/output/TASK-037-gates.json`、`.spec-loop/tasks/task-056/ACCEPTANCE_RUN.json`。
