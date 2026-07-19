# TASK-017：统一目标规格模板事实源

- 状态：已批准
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-07-19
- 最后更新：2026-07-19
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 风险等级：heavy
- Spec-Loop Task：.spec-loop/tasks/task-017
- Proposal：PROP-1
- 依赖工单：TASK-012、TASK-016

## 目标

将 spec-template 的成熟规格结构以只读来源吸收到 Spec-Loop，建立版本化目标规格模板资产，改为资源驱动初始化，修复规格检查与自身规范不一致的问题，同时保持 spec-template 仓库原状。

## 工作范围

### 包含

- 对比 `spec-template/spec/`、Spec-Loop 自身规格库和 `project init` 内联模板；
- 在 Spec-Loop 仓库建立带版本清单的目标规格模板资产；
- 让 Project 初始化、补建与检查共享同一模板契约；
- 修复自托管检查发现的合法任务文件名误判、状态不统一和占位符误报；
- 增加模板完整性、不覆盖、兼容和对抗测试。

### 不包含

- 不删除、归档、提交或重置 `spec-template` 仓库；
- 不迁移 Quant System 规格库；该工作在本任务 Delivery 后单独执行；
- 不启动 Phase 4 自动 Controller。

## 验收标准

- [ ] AC-1：建立包含 README、Roadmap、Architecture、四层模板和两个看板的版本化模板资产，并明确唯一事实源。
- [ ] AC-2：project init 和 spec-init 从模板资产读取，只补缺且不覆盖目标工程已有内容。
- [ ] AC-3：project spec-check 要求 architecture 并接受由任务 ID 和 kebab-case 名称组成的文件名，同时继续拒绝非法 ID、状态、符号链接和真实占位内容。
- [ ] AC-4：Spec-Loop 自身规格库通过修正后的 spec-check，不再因普通术语产生占位符误报。
- [ ] AC-5：新增自动测试覆盖初始化、补建、不覆盖、模板完整性、文件名与占位符边界。
- [ ] AC-6：spec-template 仅作为只读输入，工作树内容和 Git 状态不被本任务修改。
- [ ] AC-7：全量、对抗和故障恢复测试通过，Evidence 绑定最终 HEAD。
- [ ] AC-8：独立 Verifier 复核模板漂移、兼容性和目标规格治理边界，Heavy 人工结论后才能 Delivery。

## 交付记录

任务 Delivery 后回写 Round、Evidence 和 revision。
