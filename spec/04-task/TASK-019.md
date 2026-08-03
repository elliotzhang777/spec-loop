# TASK-019：人工视觉验收与 Playwright Web Gate

- 状态：待验证
- 风险等级：standard
- Spec-Loop Task：.spec-loop/tasks/task-019
- Proposal：PROP-3
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-07-23
- 最后更新：2026-07-23
- 所属设计：[DES-003](../03-design/DES-003-project-loop-agent-harness.md)、[DES-006](../03-design/DES-006-engineering-toolchain-adapters.md)
- 所属特性：[FEAT-003](../02-feature/FEAT-003-project-loop-agent-execution.md)、[FEAT-006](../02-feature/FEAT-006-engineering-toolchains.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-013、TASK-016

## 目标

为 UI 效果图增加绑定候选版本和截图哈希的人工验收卡点，并为 Web 系统任务增加 Playwright 真实功能 Gate 与原生 Evidence。

## 工作范围

### 包含

- 在 Task Acceptance 中声明必需的视觉 Review 及其 AC 覆盖；
- 增加 Review request/decide/status CLI，绑定 Round、revision、图片副本和 SHA-256；
- Verification 与 Delivery 对未批准、被拒绝、过期或被篡改 Review fail closed；
- 在 `GATES.md` 增加 `kind: playwright`，调用目标 worktree 本地 CLI；
- 收集并复核 JSON、HTML、截图、trace/video 等附件 Manifest；
- 更新目标规格模板、架构、Feature、Design、README 和对抗测试。

### 不包含

- 不实现 Phase 4 自动 Gate Planner、Scheduling 或多任务 Controller；
- 不把 Playwright 安装到 Spec-Loop 自身，浏览器版本由目标 Web 工程锁定；
- 不允许人工视觉通过替代功能测试，也不允许 Playwright PASS 替代人工效果判断。

## 验收标准

- [x] AC-1：视觉任务可声明强制人工效果验收，未批准、被拒绝、revision 漂移或截图篡改均阻断交付
- [x] AC-2：Playwright Gate 使用目标工程锁文件约束的本地 CLI，至少执行一项测试并归档 JSON、HTML、适用附件及哈希；视觉路径必须包含截图
- [x] AC-3：Harness Report 验证完整 Gate Plan 与 Playwright Evidence，零测试、flaky、缺少声明为必需的截图、超时或产物篡改不得通过
- [x] AC-4：目标规格模板、总体架构、Feature、Design、README 和测试同步更新

## 验证计划

| AC | 验证方法 | 预期结果 |
|---|---|---|
| AC-1 | `test/review.test.mjs` | 未请求、revision 漂移、图片篡改与非图片证据被阻断，批准后可验证 |
| AC-2 | `test/playwright-gate.test.mjs` | 目标本地 CLI 运行，至少一项测试、HTML/JSON/截图和 Manifest 被归档 |
| AC-3 | Gate Plan 漂移、Playwright 零测试与附件篡改对抗 | Gate/Report 明确失败，恢复原文件后可复验 |
| AC-4 | `npm test`、`project spec-check`、`git diff --check` | 全量回归与规格一致性通过 |

## 交付记录

实现与规格已完成。首轮历史审查发现的伪图片、旧 Collect 缺指纹、tracked 删除和模板版本兼容四项 P1 已修复。2026-08-03 正式复核又发现 Gate Plan 未完整绑定、Review 目录父级软链、依赖锁来源和规格边界漂移，已进入 Round 2 加固并新增不可变目标规格资产 v4；功能型 Gate 可显式不要求截图，但 UI/视觉 AC 仍必须独立声明视觉 Review，二者不可互相替代。

## 验证证据

| 日期 | 验证范围 | 结果 | 证据 |
|---|---|---|---|
| 2026-07-23 | Review、Playwright、目标模板专项 | PASS | 16/16 |
| 2026-07-23 | 全量自动化回归 | PASS | 50/50 |
| 2026-07-23 | `project spec-check`、Task check、`git diff --check` | PASS | 本地命令输出 |
| 2026-07-23 | 首轮独立源码审查 | 修复后待复核 | 4 项 P1 已逐项修复并增加回归 |
