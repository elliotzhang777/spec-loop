# TASK-018：治理工程目录与历史证据归档

- 状态：已批准
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-07-19
- 最后更新：2026-07-19
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 风险等级：standard
- Spec-Loop Task：.spec-loop/tasks/task-018
- Proposal：PROP-2
- 依赖工单：TASK-014、TASK-017

## 目标

整理 Spec-Loop 工程根目录，将历史证据按阶段归档，明确源码、测试、运行时资产、规格和生成目录边界，同时保持运行行为与历史证据可追踪。

## 工作范围

### 包含

- 将 Phase 1–2 的原始测试输出和 Dogfood 归档到 `spec/05-delivery/phase-1-2/`；
- 将已撤回的 Phase 3 Dogfood 现场归档到 `spec/05-delivery/phase-3-withdrawn/`；
- 更新所有权威引用、根 README、规格库 README 和总体架构中的目录说明；
- 补齐生成目录与事务目录的忽略规则，清理空的历史目录。

### 不包含

- 不修改 CLI 行为、状态机、Harness 或安全策略；
- 不为了目录对称拆分当前仅 9 个文件的 `src/`；
- 不改写历史 Evidence 内容或重签旧 Delivery。

## 验收标准

- [ ] AC-1：根目录的版本化内容只保留工程入口配置、源码、测试、运行时资产和规格库。
- [ ] AC-2：历史 artifacts 与 dogfood 按 Phase 归档到 spec/05-delivery，原始内容保持不变。
- [ ] AC-3：源码与测试不做无收益的模块拆分，CLI、打包和运行行为保持兼容。
- [ ] AC-4：所有旧路径引用更新，规格库入口、总体架构和目录治理工单同步说明新布局。
- [ ] AC-5：本地控制、事务、依赖和编译产物边界明确，空的历史目录被清理。
- [ ] AC-6：全量测试、spec-check、diff-check 和 npm pack dry-run 通过。

## 交付记录

任务 Delivery 后回写 Round、Evidence 和 revision。
