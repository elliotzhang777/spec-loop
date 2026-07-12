# FEAT-001：文件驱动任务生命周期

- 状态：已完成
- 负责人：zhangbo
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)

## 用户价值

作为任务执行者，我希望用透明文件管理规格、计划、工作、验证和交付，从而可以检查、恢复并证明一个真实工程任务已经完成。

## 行为说明

任务按 `draft → planned → working → verifying/iterating → delivered` 迁移。CLI 是唯一合法状态转换入口；Round 连续编号；每条 `AC-N` 必须映射当前 Round、当前 revision 的有效 Evidence。

## 业务规则

1. `TASK_STATE.md` 是当前生命周期和 Round 的唯一权威源。
2. 状态转换必须写入 `STATE_HISTORY.jsonl`，伪造状态必须失败。
3. Light、Standard、Heavy 使用同一生命周期，Heavy 额外要求 Context、独立 Verifier、人工检查和当前 Round 签署。
4. 空模板、占位内容、跳号 AC/Round、过期 Evidence 和不完整 Delivery 必须失败。
5. 多文件转换使用 prepared journal 和原子 rename，下一命令先恢复事务。

## 验收标准

- AC-1：三种任务等级均能初始化严格模板。
- AC-2：只有合法 CLI 命令能完成状态转换，Round 从 1 连续增加。
- AC-3：Delivery 完整映射全部 AC 和有效 Evidence 后才能 delivered。
- AC-4：Heavy 缺少独立 Verifier、人工检查或当前 Round 签署时拒绝交付。
- AC-5：中断事务可恢复，伪造和占位内容被拒绝。

## 非功能要求

- 安全与隐私：不得在生命周期文件中记录 Secret。
- 兼容性：Node.js 22+，本地文件系统。
- 可观测性：状态版本、历史、Round、Evidence 和 Delivery 可检查。

## 设计与工单

| 类型 | 文档 | 状态 |
|---|---|---|
| Design | [DES-001 文件契约、状态机与验收](../03-design/DES-001-file-contract-lifecycle-acceptance.md) | 已完成 |
| Task | [TASK-001 Phase 1 实现](../04-task/TASK-001-implement-file-lifecycle.md) | 已完成 |

## 实际交付

- 已实现行为：三级任务、模板、状态机、CLI、Round、Evidence、Delivery、Heavy 门禁和恢复。
- 验证结论：自动化测试通过，Standard/Heavy Dogfood delivered。
- 关联完成工单：TASK-001。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 同步已实现 Phase 1 | 规格库重组 | TASK-001 |

