# TASK-015：建立系统总体架构说明

- 状态：已完成
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-07-12
- 最后更新：2026-07-12
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 任务等级：Light

## 目标

在规格库根目录建立技术层最高入口，集中定义核心模块、控制链、事实源、Worktree/Harness 关系、安全边界和阶段演进。

## 验收标准

- [x] AC-1：`spec/architecture.md` 成为系统总体架构权威说明。
- [x] AC-2：定义 Controller、Maker、Gate、Verifier、Guard、Spec/AC 和 Evidence 的职责边界。
- [x] AC-3：说明 Worktree、Harness、Task、Round 和 Evidence 的关系。
- [x] AC-4：说明 Phase 3、Phase 4 和 Phase 5 的职责演进。
- [x] AC-5：列出权威事实源、安全边界和专项 Design 索引。
- [x] AC-6：DES-003 删除重复系统定义并链接总体架构。

## 交付记录

新增 `spec/architecture.md`；系统级定义从 DES-003 迁移到总体架构，DES-003 回归 Project Loop 专项设计。
