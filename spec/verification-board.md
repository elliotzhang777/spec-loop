# 验证看板

> 临时验证队列。验证方案、Evidence 和结论必须写回对应工单。

## 待验证概览

| 工单 | 验证范围 | 验证方式 | 验证人 | 状态 | 环境/入口 | 更新时间 |
|---|---|---|---|---|---|---|
| [TASK-030](04-task/TASK-030-pmvr-acceptance-loop.md) | v2 Contract、HEAD/计划/Evidence 绑定、V/R 路由、预算、Conflict/Inbox、调度和 v1 兼容 | 独立 V 执行定向 Gate；独立 R 复核 Evidence，必要时再申请 Heavy | 待独立 V/R | 待验证 | `src/acceptance-loop.ts`、`test/acceptance-loop.test.mjs` | 2026-08-31 |

Phase 1–3 的验证已写入已完成工单和阶段交付归档。

## 使用规则

- 只有实现完成且具备验证条件的工单才能进入。
- 验证失败时写回工单，恢复为进行中并移回待完成看板。
- 验证通过时同步 Task、Design、Feature、Product，然后删除看板条目。
