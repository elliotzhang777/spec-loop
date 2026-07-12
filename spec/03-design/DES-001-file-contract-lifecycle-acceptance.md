# DES-001：文件契约、状态机与验收

- 状态：已完成
- 负责人：zhangbo
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属特性：[FEAT-001](../02-feature/FEAT-001-file-task-lifecycle.md)

## 设计目标

覆盖 FEAT-001 的三级任务、文件契约、合法状态、连续 Round、Evidence、Heavy 门禁和可恢复 Delivery。

## 现状与约束

- 现状：Phase 1 已实现并通过 Dogfood。
- 技术约束：Node.js 22+、TypeScript、Markdown/YAML、Zod、本地文件系统。
- 不在范围：Agent 调用、后台调度、Git worktree、自动命令执行。

## 方案概览

```text
SPEC → PLAN → ROUND/WORK → VERIFY → ITERATE → ACCEPTANCE → DELIVERY
            TASK_STATE.md + STATE_HISTORY.jsonl
```

CLI 读取严格文件 Schema，以 prepared transaction journal 原子写入状态和关联文件。实现者不能通过手工编辑获得合法状态。

## 详细设计

### 任务目录

```text
TASK/
├── SPEC.md
├── PLAN.md
├── TASK_STATE.md
├── STATE_HISTORY.jsonl
├── ACCEPTANCE.md
├── VERIFY.md
├── DELIVERY.md
├── CONTEXT.md              # Heavy 必须
├── ROUNDS/ROUND-0001.md
├── evidence/EV-N.json
└── .spec-loop-tx/
```

### 状态机与 CLI

| 命令 | From | To |
|---|---|---|
| `plan` | draft | planned |
| `round` | planned、iterating | working |
| `verify --result pass` | working | verifying |
| `verify --result fail` | working、verifying | iterating |
| `deliver` | verifying | delivered |

其他命令：`init`、`check`、`status`、`next`。每次转换增加 `state_version`；Round 从 1 连续生成。

### 文件 Schema

- 所有机器读取 Markdown 使用严格 YAML frontmatter，未知字段失败。
- `TASK_STATE.md` 是当前状态和 Round 唯一事实源。
- `STATE_HISTORY.jsonl` 保存版本、状态、Round、命令和 state hash，用于识别伪造。
- AC 必须从 `AC-1` 连续且唯一。
- Evidence 包含 task、Round、code revision、artifact、SHA-256、exit code 和时间。
- Delivery 每个 AC 只能出现一次，并引用当前 Round/revision 的成功 Evidence。

### 任务等级

| 要求 | Light | Standard | Heavy |
|---|---:|---:|---:|
| 基础任务文件、Round、Evidence | 必须 | 必须 | 必须 |
| CONTEXT | 可选 | 可选 | 必须 |
| 独立 Verifier | 可选 | 建议 | 必须 |
| 人工检查、当前 Round 签署 | 可选 | 建议 | 必须 |

### 原子恢复

多文件命令先写 temp，再持久化 prepared journal，最后 atomic rename。下一次 mutating/check 命令先 roll forward；temp 或 target hash 不一致时硬失败，不猜测状态。

### 错误处理与边界

空内容、`TODO/TBD/unknown`、重复/跳号 AC、缺失 Round、旧 Evidence、Heavy 门禁缺失和非法转换全部拒绝。

### 安全与可观测性

生命周期历史、Round、Evidence hash 和 Delivery 映射可审计；文件机制不是防恶意全量重写的密码学签名。

## 方案取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Markdown + history | 透明、Git 友好、Agent 易读 | 并发和强事务有限 | Phase 1 采用 |
| SQLite | 强事务、查询和并发好 | 第一阶段复杂度高 | 多任务阶段再评估 |

## 风险与回滚

| 风险 | 影响 | 缓解措施 | 回滚方式 |
|---|---|---|---|
| 手工篡改状态 | 生命周期不可信 | history hash + check | 恢复到最后合法版本 |
| 多文件中断 | 部分写入 | journal + recovery | roll forward 或硬失败保留现场 |

## 验证策略

| 验收标准 | 验证层级 | 方法 | 预期结果 |
|---|---|---|---|
| FEAT AC-1～4 | E2E/对抗 | Standard、Heavy 生命周期和拒绝测试 | 合法交付、非法失败 |
| FEAT AC-5 | 故障注入 | prepared journal 恢复测试 | 两个文件完整恢复 |

## 工单拆分

| 工单 | 交付物 | 依赖 | 状态 |
|---|---|---|---|
| [TASK-001](../04-task/TASK-001-implement-file-lifecycle.md) | Phase 1 CLI 和文件契约 | 无 | 已完成 |

## 实际实现

- 最终实现：`src/model.ts`、`files.ts`、`schemas.ts`、`templates.ts`、`task.ts`、`cli.ts`。
- 与设计差异：增加 `STATE_HISTORY.jsonl` 作为伪造检测轨迹，但当前事实仍由 TASK_STATE 提供。
- 关联完成工单：TASK-001。

## 变更记录

| 日期 | 变更 | 原因 | 关联工单 |
|---|---|---|---|
| 2026-07-12 | 重组 Phase 1 最终设计 | 规格库模板化 | TASK-001 |

