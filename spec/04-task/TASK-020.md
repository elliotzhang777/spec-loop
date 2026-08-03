# TASK-020：同步分工程规格模板并写入源码仓

- 状态：已完成
- 风险等级：standard
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-07-24
- 最后更新：2026-08-03
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-017、TASK-019

## 目标

把 `spec-template` 最新的后端主规格库和前端卫星规格库吸收到 Spec-Loop 的版本化资产中，使 `project init/spec-init` 能把规格库直接放进目标工程源码仓，并由 `spec-check` 校验。

## 工作范围

### 包含

- 新增不可变目标规格资产 v3；
- 支持 `standard`、`backend`、`frontend`、`fullstack` 规格配置；
- 全栈配置在目标仓库的 `backend/` 与 `frontend/` 下分别初始化规格库和 `AGENT.md`；
- 后端 Task 使用 `TASK-*`，前端 Task 使用 `WEB-TASK-*`，并写入对应源码目录；
- 初始化只补缺、不覆盖已有源码或规格；
- 更新 CLI、规格说明和定向测试。

### 不包含

- 不自动改写既有项目的规格目录；
- 不在本工单内初始化 `independent-erp`；
- 不替目标项目填写模板中的业务与技术决策。

## 验收标准

- [x] AC-1：`project init --spec-profile fullstack` 在目标源码仓生成后端主规格库和前端卫星规格库
- [x] AC-2：`backend`、`frontend`、`fullstack` 初始化均只补缺且不覆盖已有文件
- [x] AC-3：`spec-check` 能校验新版目录、正式后端规格和前端 `WEB-TASK`
- [x] AC-4：Proposal 创建的 `TASK-*` 与 `WEB-TASK-*` 分别写入正确的源码规格目录
- [x] AC-5：旧 `standard` 项目继续兼容，模板资产、CLI、README 和测试同步更新

## 验证计划

| AC | 验证方法 | 预期结果 |
|---|---|---|
| AC-1～AC-3 | `test/target-spec.test.mjs` | 三种新版配置的初始化、补缺、校验和安全边界通过 |
| AC-4 | `test/project.test.mjs` | 后端与 Web Task 路由正确 |
| AC-5 | `npm run build` 与上述定向测试 | 编译和受影响测试通过 |

## 交付记录

已新增并演进目标规格资产至 v4，支持四种规格配置、源码仓安全补建、正式规格检查和 Task 路由。正式候选 `23d9d25` 修复了 Proposal Task 生成后立即触发占位检查的问题，恢复 v1 原始发布内容，并使用 `releases.json` 锁定 v1～v4 的路径与内容摘要。

- 独立 Verifier：PASS，P0/P1 为 0；记录 1 项非阻断的 fullstack Web Task 回归覆盖建议。
- 定向验证：Target-Spec 与 Project 路由测试 16/16 通过，TypeScript 编译通过。
- Evidence：`.spec-loop/tasks/task-020/evidence/EV-1.*`，绑定 revision `23d9d254df943de3a44940ba650b48402f5bc8aa`。
- 验证范围：仅 TASK-020 targeted Gate；Phase 3 全量回归仍由 TASK-013 唯一 Heavy 执行。
