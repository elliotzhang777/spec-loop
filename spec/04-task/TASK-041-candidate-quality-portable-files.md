# TASK-041：候选质量检查兼容示例配置与 CRLF

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-19
- 最后更新：2026-09-29
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
- 完整 Gate、merge、push 或发布；独立定向 V/R 已在批准范围内完成。

## 验收标准

- [x] AC-1：`.env.example`、`.env.sample`、`.env.template` 不再被候选质量策略当作 Secret。
- [x] AC-2：标准 CRLF 文件不触发尾随空白失败，普通尾随空格仍会失败。
- [x] AC-3：真实 `.env`、其他环境文件和私钥规则不被放宽。
- [x] AC-4：TypeScript 构建与 acceptance-loop 定向测试通过。

## 验证范围

- `scope_kind: task`，`coverage: targeted`。
- 当前执行约定允许已批准 Task 内连续完成定向 V/R；候选变化重新绑定证据。

## 交付记录

- 完成日期：2026-09-29；候选 `eca847d` 独立 Light V/R 双 PASS。
- 变更文件/交付物：`src/role-orchestrator.ts`、`test/acceptance-loop.test.mjs`。
- 快速反馈：`npm run build` 通过；`node --test test/acceptance-loop.test.mjs` 18/18 通过。
- 关键实现：明确 allowlist 三种公开环境示例文件；Git 空白检查启用 `cr-at-eol`，测试候选同时包含 `.env.example` 和 CRLF 文件。
- 正式证据：`.spec-loop/output/TASK-041-{V,R}-eca847d.json`。隔离 Git fixture 证实三种公开示例与纯 CRLF PASS；`.env`、其他环境文件、私钥和 LF/CRLF 尾随空格 FAIL。同 HEAD 的构建与 acceptance-loop 34/34 复用 TASK-040 Gate。
- 遗留风险：此策略按文件名识别敏感文件，不代表示例文件内容的 Secret 扫描；完整 Heavy、merge、push 和发布仍按各自任务执行。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-19 | 创建并开始实施 | 海工 TASK-001 首个干净候选暴露公开示例配置与 Maven Wrapper CRLF 误报 |
| 2026-09-19 | 实现候选进入待验证 | 构建与 18 项 acceptance-loop 定向回归通过，等待独立正式 V/R |
| 2026-09-29 | 完成独立 Light V/R 并关闭工单 | AC-1～4 全通过，文件名策略与真实尾随空格边界未弱化 |
