# TASK-041：候选质量检查兼容示例配置与 CRLF

- 状态：待验证
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-19
- 最后更新：2026-09-19
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-032 实现候选、TASK-040 实现候选
- 任务等级：Light
- 协议版本：P/M/V/R v2
- 所属批次：目标工程接入修复

## 目标

让 M 候选质量策略继续拒绝真实 Secret 和真实空白错误，同时允许公开的 `.env.example` / `.env.sample` / `.env.template` 以及标准 Windows CRLF 文件。

## 工作范围

### 包含

- Secret 文件规则允许三种明确的公开示例配置后缀；
- `.env`、其他 `.env.*`、私钥及证书私钥文件继续 fail closed；
- `git diff --check` 使用 `core.whitespace=cr-at-eol`，忽略 CRLF 的 CR 字节但仍拒绝真实尾随空格；
- acceptance-loop 定向回归覆盖示例配置与 CRLF 候选。

### 不包含

- 放宽真实 Secret 检查；
- 忽略普通源码或脚本中的尾随空格；
- 正式 V/R、完整 Gate、merge、push 或发布。

## 验收标准

- [x] AC-1：`.env.example`、`.env.sample`、`.env.template` 不再被候选质量策略当作 Secret。
- [x] AC-2：标准 CRLF 文件不触发尾随空白失败，普通尾随空格仍会失败。
- [x] AC-3：真实 `.env`、其他环境文件和私钥规则不被放宽。
- [x] AC-4：TypeScript 构建与 acceptance-loop 定向测试通过。

## 验证范围

- `scope_kind: task`，`coverage: targeted`。
- 本轮只做实现与快速反馈；正式独立 V/R 需另获当前稳定候选授权。

## 交付记录

- 完成日期：2026-09-19，实现候选待正式验证。
- 变更文件/交付物：`src/role-orchestrator.ts`、`test/acceptance-loop.test.mjs`。
- 快速反馈：`npm run build` 通过；`node --test test/acceptance-loop.test.mjs` 18/18 通过。
- 关键实现：明确 allowlist 三种公开环境示例文件；Git 空白检查启用 `cr-at-eol`，测试候选同时包含 `.env.example` 和 CRLF 文件。
- 遗留风险：正式独立 V/R 尚未授权。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-19 | 创建并开始实施 | 海工 TASK-001 首个干净候选暴露公开示例配置与 Maven Wrapper CRLF 误报 |
| 2026-09-19 | 实现候选进入待验证 | 构建与 18 项 acceptance-loop 定向回归通过，等待独立正式 V/R |
