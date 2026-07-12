# TASK-002：实现 Phase 2 Runtime Ledger 与 Guard

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属设计：[DES-002](../03-design/DES-002-ledger-guard-recovery.md)
- 所属特性：[FEAT-002](../02-feature/FEAT-002-runtime-ledger-guard.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-001

## 目标

实现严格 Attempt 历史、预算、Guard、事实摘要和中断恢复，使多轮失败不会无限循环或丢失证据。

## 工作范围

### 包含

- runtime-init、attempt、guard、summary；
- LOOP_LEDGER、RUN_LOG、BUDGET、RUN_SUMMARY；
- 连续 Attempt/Round 和严格 JSON；
- stop/needs_user/continue；
- Secret、分叉和占位指纹拒绝；
- Heavy 两 Round Dogfood。

### 不包含

- 自动 Provider 调用、自动 Token 统计、后台 Scheduler。

## 实施要求

1. Ledger 是 Attempt 唯一事实源，Log/Summary 只能派生。
2. iterating 开新 Round 前自动 Guard。
3. 初始化/追加中断后恢复，不留部分记录。
4. 所有失败审查和修复 Round 保留。

## 验收标准

- [x] AC-1：四个运行时文件原子初始化。
- [x] AC-2：Attempt、Round、JSON 和 Budget 严格验证。
- [x] AC-3：Guard 对预算、失败、重复错误和无进展正确决策。
- [x] AC-4：Ledger、Log、Summary 保持一致且可重建。
- [x] AC-5：Heavy 真实任务多轮独立验收并 delivered。

## 验证计划

| 验收标准 | 验证方法/命令 | 预期结果 |
|---|---|---|
| AC-1～4 | `npm test` | runtime/对抗/恢复测试通过 |
| AC-5 | Heavy final Dogfood | Round 1 拒绝、Guard continue、Round 2 delivered |

## 交付记录

- 完成日期：2026-07-12
- 变更文件/交付物：`src/runtime.ts`、task/CLI 集成、runtime tests、Heavy Dogfood。
- 关键实现与决策：JSONL 事实源、确定性投影、三类 Guard 决策、写入前严格验证。
- 与原设计的差异：Token/work units 当前由调用者提供。
- 遗留风险：未自动采集 Provider token；无后台调度。

## 验证证据

| 日期 | 验证人 | 环境 | 结果 | 证据/输出 |
|---|---|---|---|---|
| 2026-07-12 | node:test | 本地 Node.js | 21/21 通过 | `artifacts/final-phase1-2-test.txt` |
| 2026-07-12 | independent-final-test-and-human-review | Heavy Round 2 | delivered | `dogfood/heavy-final/VERIFY.md`、`DELIVERY.md` |
| 2026-07-12 | npm audit | 官方 registry | 0 vulnerabilities | Phase 1–2 Delivery Report |

## 关闭检查

- [x] 验收标准全部通过
- [x] 测试/检查结果已记录
- [x] 设计差异已记录
- [x] Design、Feature、Product 实际结果已更新
- [x] 已从两个看板移除

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-07-12 | 完成 Phase 2 并补录工单 | 规格库模板化 |

