# FEAT-002：运行账本、预算与 Guard

- 状态：已完成
- 负责人：zhangbo
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)

## 用户价值

作为多轮任务执行者，我希望每次真实尝试被严格记录，并在重复失败、无进展或预算耗尽时停止，从而避免无限循环和不可解释的成本。

## 行为说明

`runtime-init` 建立 Budget、Ledger、Run Log 和 Summary；`attempt` 顺序追加事实；`guard` 依据账本返回 `continue`、`stop` 或 `needs_user`；从 iterating 开启新 Round 前自动执行 Guard。

## 业务规则

1. `LOOP_LEDGER.jsonl` 是 Attempt 历史唯一事实源。
2. Attempt 和 Round 不得倒退、跳号或超过当前 Round。
3. RUN_LOG 与 RUN_SUMMARY 是确定性派生文件，分叉必须失败。
4. Budget 只接受已定义字段。
5. 失败错误指纹必须实质性，禁止 `none/TBD/unknown`。
6. Attempt、日志和摘要不得保存密码、Token、Cookie。

## 验收标准

- AC-1：runtime-init 原子建立四个运行时文件。
- AC-2：畸形、重复/未知字段和不连续 Attempt 被拒绝。
- AC-3：Guard 正确处理绝对预算、连续失败、重复错误和无进展。
- AC-4：Ledger/Run Log/Summary 分叉被发现。
- AC-5：Heavy 任务保留失败 Round，经 Guard 后完成新 Round 并 delivered。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-002 Ledger、Guard 与恢复](../03-design/DES-002-ledger-guard-recovery.md) | 已完成 |
| Task | [TASK-002 Phase 2 实现](../04-task/TASK-002-implement-runtime-guard.md) | 已完成 |

## 实际交付

- 已实现行为：严格 Ledger、Budget、Guard、生成式 Log/Summary、原子恢复和 Secret 拒绝。
- 验证结论：Heavy final Dogfood 在 Round 1 拒绝旧证据，Guard 后 Round 2 delivered。
- 关联完成工单：TASK-002。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 同步已实现 Phase 2 | 规格库重组 | TASK-002 |

