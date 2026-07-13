# 验证看板

> 临时验证队列。验证方案、Evidence 和结论必须写回对应工单。

## 待验证概览

| 工单 | 验证范围 | 验证方式 | 验证人 | 状态 | 环境/入口 | 更新时间 |
|---|---|---|---|---|---|---|
| [TASK-013](04-task/TASK-013-phase3-hardening-acceptance.md) | Phase 3 安全、恢复、Evidence 闭环 | 全量测试、加固版 Dogfood、独立 Heavy 验收 | 待指定 | 待验证 | `npm test` / Project Dogfood | 2026-07-12 |

Phase 1–2 的验证已写入已完成工单和 Dogfood 目录。

## 使用规则

- 只有实现完成且具备验证条件的工单才能进入。
- 验证失败时写回工单，恢复为进行中并移回待完成看板。
- 验证通过时同步 Task、Design、Feature、Product，然后删除看板条目。
