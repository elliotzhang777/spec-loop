# TASK-060：波次 Review Gate 默认浏览器缺失

- 状态：已完成
- 风险等级：standard
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-10-01
- 所属设计：[DES-009](../03-design/DES-009-execution-visualization.md)
- 所属特性：[FEAT-009](../02-feature/FEAT-009-execution-visualization.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 来源轮次：第九轮 TASK-037 浏览器预检，关联 AC-4/8
- 实施归属：TASK-058 Heavy 候选及 TASK-037 最终矩阵

## 缺陷与验收

`tools/check-wave-review-browser.mjs` 默认调用 Playwright 缓存中的 Chromium Headless Shell，当前安装版本的二进制缺失。使用本机现有 Google Chrome 的显式可执行路径运行同一脚本，7 张截图及桌面/窄屏交互 PASS。

- [x] AC-1：脚本在当前目标环境自动选用可用的浏览器二进制，并在缺失时明确报错；仍可通过显式环境变量覆盖。
- [x] AC-2：真实浏览器 Gate 生成 7 张可读截图，交互及浏览器控制台检查通过，当前候选视觉 Review 可复核。

## 最终裁决

修复进入 TASK-058 Heavy Candidate `bc91388` 及 TASK-037 集成 Candidate `2ebee82`。当前 `phase4-wave-review` 真实浏览器 Gate 退出 0，生成 7 张截图且无控制台错误；当前 revision 的桌面/窄屏截图已纳入 TASK-037 `REVIEW-1` 投影和哈希历史。TASK-037 完整 8/8 Gate、独立 V/R 均 PASS。Evidence 见 `.spec-loop/output/TASK-037-gate-phase4-wave-review-fa2df8c3-c6b3-48ce-b83a-7a1eb8b1e7dd.txt` 与 `.spec-loop/tasks/task-037/reviews/REVIEW-1.md`。
