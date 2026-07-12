# TASK-004：Project metadata 与 Project State

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：无

## 目标

实现严格、版本化 Project metadata 和不覆盖 Task State 的 Project State。

## 验收标准

- [x] AC-1：project init 创建严格 Schema 文件。
- [x] AC-2：未知字段和坏仓库路径失败，Project ID 使用严格格式。
- [x] AC-3：Project 原生字段与 Task 派生查询分离。
- [x] AC-4：复用原子事务层，中断写入可恢复。

## 交付记录

- 实现：`src/project.ts` 的 Project Schema、init/read 和 CLI `project init/status`。
- 验证：`test/project.test.mjs`。
