# TASK-001：实现 Phase 1 文件驱动生命周期

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属设计：[DES-001](../03-design/DES-001-file-contract-lifecycle-acceptance.md)
- 所属特性：[FEAT-001](../02-feature/FEAT-001-file-task-lifecycle.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：无

## 目标

从零实现可运行的本地 CLI，使 Light、Standard、Heavy 任务能够通过严格文件契约和合法命令完成生命周期与 Evidence Delivery。

## 工作范围

### 包含

- TypeScript CLI 与严格 Schema；
- Markdown 模板和任务目录；
- TASK_STATE、STATE_HISTORY 和六态状态机；
- 连续 Round、AC 和 Evidence；
- Heavy 门禁；
- 多文件事务恢复；
- E2E 和对抗测试；
- Standard/Heavy Dogfood。

### 不包含

- Agent 自动调用、Git worktree、后台调度、外部 Connector。

## 实施要求

1. 空模板、占位、伪造、不完整验收必须失败。
2. 状态只通过 CLI 合法转换。
3. Delivery 逐 AC 映射当前 Evidence。
4. 真实业务代码仍是外部事实源。

## 验收标准

- [x] AC-1：三级任务模板和规则被强制执行。
- [x] AC-2：状态和 Round 只能合法、连续转换。
- [x] AC-3：Delivery 完整映射全部 AC 和有效 Evidence。
- [x] AC-4：Heavy 独立 Verifier、人工检查和 Round 签署被强制。
- [x] AC-5：事务恢复、伪造和占位拒绝通过测试。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1～5 | `npm test` | E2E、对抗和恢复测试全部通过 |
| AC-1～5 | `node dist/cli.js check dogfood/standard-final --json` | ok=true |
| AC-1～5 | `node dist/cli.js check dogfood/heavy-final --json` | ok=true |

## 交付记录

- 完成日期：2026-07-12
- 变更文件/交付物：`src/`、`test/`、任务模板、Dogfood、README。
- 关键实现与决策：Markdown 权威状态 + history integrity；journal + atomic rename；Zod strict schemas。
- 与原设计的差异：为检测手工伪造增加 STATE_HISTORY；未引入 SQLite。
- 遗留风险：历史不是恶意全量篡改下的密码学签名；revision 由调用者提供。

## 验证证据

| 日期 | 验证人 | 环境 | 结果 | 证据/输出 |
|---|---|---|---|---|
| 2026-07-12 | node:test + 独立检查 | 本地 Node.js | 通过 | `artifacts/final-phase1-2-test.txt` |
| 2026-07-12 | spec-loop | Standard Dogfood | delivered | `dogfood/standard-final/DELIVERY.md` |
| 2026-07-12 | 独立 Verifier + 人工检查 | Heavy Dogfood | delivered | `dogfood/heavy-final/DELIVERY.md` |

## 关闭检查

- [x] 验收标准全部通过
- [x] 测试/检查结果已记录
- [x] 设计差异已记录
- [x] Design、Feature、Product 实际结果已更新
- [x] 已从两个看板移除

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-07-12 | 完成 Phase 1 并补录工单 | 规格库模板化 |

