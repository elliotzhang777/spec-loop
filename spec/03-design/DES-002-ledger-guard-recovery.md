# DES-002：Ledger、Budget、Guard 与运行摘要

- 状态：已完成
- 负责人：zhangbo
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属特性：[FEAT-002](../02-feature/FEAT-002-runtime-ledger-guard.md)

## 设计目标

让多轮真实尝试可顺序记录、按预算熔断、确定性总结，并在初始化或追加中断后恢复。

## 现状与约束

- 现状：Phase 2 已实现。
- 技术约束：JSONL append 语义、Markdown 人类视图、与 Phase 1 文件事务共用恢复层。
- 不在范围：自动 Agent 调用和后台 Scheduler。

## 方案概览

```text
BUDGET.md + LOOP_LEDGER.jsonl
              ↓
            Guard
              ↓
 RUN_LOG.md + RUN_SUMMARY.md
```

Ledger 是 Attempt 事实源；Log 和 Summary 可以从状态、Budget、Ledger 重新生成。

## 详细设计

### 运行文件

- `BUDGET.md`：最大 Attempt、连续失败、重复错误、无进展、Token、工作量。
- `LOOP_LEDGER.jsonl`：严格、连续、顺序 Attempt。
- `RUN_LOG.md`：Ledger 的确定性表格投影。
- `RUN_SUMMARY.md`：仅从 State、Budget、Ledger 生成。

### Attempt

字段：schema version、attempt、round、timestamp、action、outcome、error fingerprint、tokens、work units。编号从 1 连续；Round 不得倒退或超过当前 Round；只允许在 working/verifying/iterating 写入。

### Guard

| 条件 | 决策 |
|---|---|
| 最大 Attempt、Token、工作量到达 | stop |
| 连续失败、相同错误、无进展到达阈值 | needs_user |
| 仍在限制内 | continue |

iterating 开启新 Round 前必须自动 Guard，只有 continue 可继续。

### 严格拒绝

畸形 JSON、重复/未知字段、Attempt 跳号、Round 倒退/越界、Budget 未知字段、Log 分叉、占位错误指纹、非法状态 Attempt 和 Secret 均失败。

### 安全与可观测性

日志和 Summary 不读取模型自由总结，不保存密码、Token、Cookie；Provider token 在当前 A0 由调用者提供。

## 方案取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| JSONL Ledger + 派生 Markdown | 简单、可追踪、可重建 | 大规模查询有限 | 当前采用 |
| 两个文件都可编辑 | 人类灵活 | 无法定义事实源 | 拒绝 |

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| Ledger/Log 分叉 | 摘要不可信 | check 确定性比较 | 从 Ledger 重建 |
| Attempt 追加中断 | 部分记录 | 原子事务 | 下次命令恢复 |

## 验证策略

| 验收标准 | 验证层级 | 方法 | 预期结果 |
|---|---|---|---|
| FEAT AC-1～4 | 单元/对抗 | Guard 和畸形输入测试 | 严格决策和拒绝 |
| FEAT AC-5 | E2E | Heavy 两 Round Dogfood | Round 1 失败，Guard，Round 2 delivered |

## 工单拆分

| 工单 | 交付物 | 依赖 | 状态 |
|---|---|---|---|
| [TASK-002](../04-task/TASK-002-implement-runtime-guard.md) | Runtime CLI 和账本 | TASK-001 | 已完成 |

## 实际实现

- 最终实现：`src/runtime.ts` 及 task/CLI 集成。
- 与设计差异：Token 和 work units 当前由外部调用者提供。
- 关联完成工单：TASK-002。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 重组 Phase 2 最终设计 | 规格库模板化 | TASK-002 |

