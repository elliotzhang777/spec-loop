# TASK-013：Phase 3 安全加固与正式验收

- 状态：待验证
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 任务等级：Heavy
- 依赖工单：TASK-003、TASK-009～012、TASK-017

## 目标

把 Phase 3 Project Loop 核心原型加固为可正式验收的受控单步执行闭环。

## 工作范围

- Workspace 路径、仓库、任务状态和脏工作区门禁；
- Gate 禁令不可被 shell/解释器包装绕过，结果绑定 cwd、task、manifest 和 HEAD；
- Harness Report 不信任未校验或过期中间文件；
- Harness 持久状态机、进程组 timeout、故障 reconcile；
- Approval 有效期、scope 和 risk 校验；
- Project root 与目标 repository 的可恢复跨根事务；
- 目标规格库结构、内容和追踪完整性检查；
- 对抗、超时、篡改与恢复测试。

## 验收标准

- [x] AC-1：Workspace 拒绝脏主仓库、越界/复用路径、未批准或非执行态任务。
- [x] AC-2：Gate 拒绝 shell 包装和高风险命令，timeout 会终止进程组并留下明确结果。
- [x] AC-3：Harness 只能按 prepare→execute→collect→verify→report 推进，reconcile 可从磁盘事实恢复。
- [x] AC-4：Report 校验 task、workspace、base、HEAD、artifact hash、新鲜度和非空 Gate，不接受伪造结果。
- [x] AC-5：Approval 过期、内容变化、scope/risk 不匹配时失效。
- [x] AC-6：创建 Task 的控制文件和目标规格使用可恢复跨根事务，不留下半创建状态。
- [x] AC-7：目标规格库检查拒绝越界、符号链接、占位内容、非法 ID/状态和断裂追踪。
- [ ] AC-8：全量、对抗和故障恢复测试通过；独立 Heavy 验收后才恢复 Phase 3 完成状态。

## 交付记录

- 实现：Workspace/Gate/Harness/Approval/跨根事务/规格库检查已加固。
- 自动验证：`npm test` 通过 30/30，包含超时、篡改、过期审批、状态顺序、符号链接和事务恢复。
- 待完成：独立 Verifier、Heavy 人工检查、加固版真实 Dogfood 和正式 Delivery。
