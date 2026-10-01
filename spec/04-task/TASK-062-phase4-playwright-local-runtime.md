# TASK-062：TASK-037 Playwright CLI 位于受管工作树外

- 状态：已完成
- 风险等级：standard
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-10-01
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 关联受管工单：TASK-037
- 来源轮次：第九轮 TASK-037 受控 V

## 问题与复现

TASK-037 当前候选 `2ebee82` 的前七组受控 Gate 全部退出 0，全量 Node 334/334。最后一组 Playwright 在启动前报 `Playwright CLI resolves outside the managed worktree`：该工作树的 `node_modules` 是指向主仓的软链接，违反 Controller 对目标本地 CLI 的隔离要求。首次重试结果见 `.spec-loop/output/ROUND9-TASK037-V2-CONTROLLED-INGEST-RETRY.json`，七组原始输出由运行 ID `139ec0e2-20db-41f6-bdac-73b6d4342d10` 保存；该轮不能记为 8/8。

## 验收标准

- [x] AC-1：工作树内安装锁文件固定版本的 Playwright CLI，realpath 保持在该工作树内，候选 Git 状态干净。
- [x] AC-2：在候选工作树运行目标 E2E 两条浏览器用例，真实 Chrome 路径通过。
- [x] AC-3：TASK-037 受控 V 的八组批准 Gate 全部通过，Playwright 报告和截图由 Controller 归档并绑定当前 HEAD。

## 修复与证据

已将原软链接归档到 `.spec-loop/output/TASK037-node-modules-original-link`，在隔离工作树运行 `npm ci --ignore-scripts --no-audit --no-fund`，安装 132 个包；Playwright CLI 的 realpath 位于 `.spec-loop/worktrees/task-037/node_modules`。目标浏览器用例直接预检为 2/2 PASS，输出目录保存在 `.spec-loop/output/TASK037-PLAYWRIGHT-PREFLIGHT-results`。这是本地 Gate 环境修复，未修改候选 HEAD。

最终受控重试运行 ID `fa2df8c3-c6b3-48ce-b83a-7a1eb8b1e7dd` 的 8/8 Gate、Node 334/334、Playwright 2/2 均 PASS，浏览器 manifest 与两张截图保存在 `.spec-loop/output/TASK-037-web-phase4-e2e-fa2df8c3-c6b3-48ce-b83a-7a1eb8b1e7dd/`；独立 V/R PASS。首次 7/8 及环境拒绝记录保留，不能误记为完整通过。
