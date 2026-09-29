# 验证看板

> 临时验证队列。验证方案、Evidence 和结论必须写回对应工单。

## 待验证概览

| 工单 | 验证范围 | 验证方式 | 验证人 | 状态 | 环境/入口 | 更新时间 |
|---|---|---|---|---|---|---|
| [TASK-028](04-task/TASK-028-execution-view.md) | 当前候选的受管 Playwright Gate 与 v1 Delivery | `4366ed8` 独立技术 V/R 和 REVIEW-1 视觉已 PASS；锁定 Playwright 已真实跑通，待最终工作树 Gate 记录 | Codex | 待验证 | `.spec-loop/output/TASK-028-browser-4366ed8.json`、`reviews/REVIEW-1.md` | 2026-09-29 |
| [TASK-033](04-task/TASK-033-pmvr-execution-observability.md) | v2 Candidate 观察面的当前 revision 人工视觉 | `ed8d0fa` 独立技术 V/R 与桌面/390px Chrome 已 PASS；人工视觉单独决定 | 用户 | 待验证 | `.spec-loop/output/TASK-033-browser-ed8d0fa.json` 与两张 PNG | 2026-09-29 |

Phase 1–3 的验证已写入已完成工单和阶段交付归档。

## 使用规则

- 已批准 Task/波次内正式 V/R 随执行授权连续推进；新 HEAD 作废旧证据，不要求重复授权。待验证表示证据或验收尚未齐备，不表示每个候选都需要重新授权；按根目录 [执行与交付授权约定](../AGENT.md) 核对范围、Gate、预算和依赖。
- 只有实现完成且具备验证条件的工单才能进入。
- 验证失败时写回工单，恢复为进行中并移回待完成看板。
- 验证通过时同步 Task、Design、Feature、Product，然后删除看板条目。
