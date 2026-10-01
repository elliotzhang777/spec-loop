# Spec-Loop

> Agent Loop 工程闭环系统，用于管理 Agent 工程任务的规格、执行、验证、迭代、验收和交付。

Spec-Loop 以本地工程和 Git 仓库为工作对象，把一次任务组织为：

```text
SPEC → PLAN → WORK → VERIFY → ITERATE → ACCEPTANCE → DELIVERY
```

目标工程始终是代码事实源；Spec-Loop 保存任务契约、生命周期、运行账本、预算、Evidence 和 Delivery，并通过 Guard、独立 Verifier 与人工门禁阻止无证据完成。

每个纳入 Spec-Loop 的目标工程还必须在源码仓维护规格库。兼容项目可继续使用根目录 `spec/`；后端、前端和全栈工程可使用新版分工程模板，把后端主规格库与前端卫星规格库直接放在对应源码目录中。`.spec-loop/` 管理闭环运行，源码仓规格库管理系统本身的长期设计事实，两者不能互相替代。

## 当前能力

- Phase 1：Light/Standard/Heavy、文件契约、状态机、Round、AC、Evidence 和 Delivery。
- Phase 2：Attempt、Ledger、Budget、Guard、事实 Summary 和失败恢复。
- Phase 3：Project Loop、受控 worktree 执行、安全加固、故障恢复和完整 Harness Evidence 闭环已完成正式 Heavy 验收。
- Phase 4：P/M/V/R v2 验收内核支持批准契约、稳定 HEAD、独立 V/R、共享返工预算、Conflict Record 与 Review Inbox；旧 v1 Task 不自动迁移。
- Phase 4：报告型 Scheduler、受控执行、真实 Standard/Heavy Dogfood、Spring Boot T2、本地确认和阶段 Heavy 已完成验收。
- Web/UI：支持目标工程本地 Playwright 功能 Gate，以及绑定 Round、revision 与截图哈希的人工视觉 Review。
- Execution View：从项目 `.spec-loop/` 重建当前 Task/步骤、历史时间线、主动/等待/未记录耗时和最长步骤；本机只读页面不会成为第二状态源。

当前默认 Agent Provider 是 Codex；Claude Code 与 Qoder 使用同一 Provider 扩展边界。Phase 4 验收结论与证据见[阶段四交付报告](spec/05-delivery/阶段四交付报告.md)。自动 push/merge/deploy 不属于引擎自动执行范围。

## 工程结构

```text
spec-loop/
├── src/                   TypeScript 产品源码
├── test/                  自动化、对抗和恢复测试
├── assets/                运行时随包资产
│   └── target-spec/        目标工程规格模板
├── products/              各目标工程的本机最终成品统一出口
├── spec/                  产品、架构、工单和交付事实源
├── AGENT.md               协作规则
├── package.json           Node.js 工程配置
├── package-lock.json      依赖锁文件
└── tsconfig.json          TypeScript 构建配置
```

`dist/`、`node_modules/`、`.spec-loop/` 和 `.spec-loop-*-tx/` 是本地生成或运行目录，不是版本化的工程结构。目标工程可安装/可分发的最终二进制统一放入 [`products/`](products/)，其内容默认不提交 Git。历史测试输出和 Dogfood 按 Phase 归档在 [`spec/05-delivery/`](spec/05-delivery/)，不再占用根目录。

## 安装与构建

```bash
npm install
npm run build
node dist/cli.js --help
```

## 快速开始

```bash
node dist/cli.js project init projects/demo --id PROJ-DEMO --name Demo --repository /path/to/target-repo
node dist/cli.js project spec-check projects/demo

node dist/cli.js init tasks/example --level standard --id TASK-001 --title "Example task"
# Fill SPEC.md, PLAN.md and ACCEPTANCE.md
node dist/cli.js plan tasks/example
node dist/cli.js runtime-init tasks/example
node dist/cli.js round tasks/example
# Fill ROUNDS/ROUND-0001.md
node dist/cli.js attempt tasks/example --action "implemented change" --outcome success --tokens 1000 --work 1
node dist/cli.js verify tasks/example --result pass --evidence evidence/test.txt --verifier verifier-1 --independent
# Fill DELIVERY.md AC mappings
node dist/cli.js deliver tasks/example
```

## P/M/V/R 验收协议 v2

v2 必须显式启用。P 先准备完整 JSON 契约（AC、用例、冻结的 Gate 命令或 Playwright 配置、断言、证据要求和预算），并把它随 Proposal 一起交给人批准：

```bash
spec-loop triage propose projects/demo \
  --source "approved product specification" \
  --goal "implement checkout" \
  --reason "deliver independently verified behavior" \
  --contract acceptance-contract-v2.json
spec-loop triage approve projects/demo PROP-1 --by product-owner
spec-loop triage create-task projects/demo PROP-1 --id TASK-CHECKOUT-1 --title "Checkout"
```

`create-task` 会自动生成绑定同一次人类 Approval 的 `ACCEPTANCE_CONTRACT_V2.md`。随后按角色推进：

```bash
spec-loop acceptance start projects/demo TASK-CHECKOUT-1
# M 在受控 worktree 提交代码和自测后：
spec-loop acceptance m-submit projects/demo TASK-CHECKOUT-1 --self-test .spec-loop/output/m-self-test.txt
spec-loop acceptance compile projects/demo TASK-CHECKOUT-1

# V 可以由引擎运行受控 Gate，也可接入独立 invocation 的结构化结果：
spec-loop acceptance v-run projects/demo TASK-CHECKOUT-1 --invocation verifier-session-1
spec-loop acceptance v-record projects/demo TASK-CHECKOUT-1 --file v-result.json

# 只有 V PASS 后，另一个 invocation 才能提交 R 复核：
spec-loop acceptance r-record projects/demo TASK-CHECKOUT-1 --file r-result.json
spec-loop acceptance status projects/demo TASK-CHECKOUT-1 --json
spec-loop acceptance schedule projects/demo --json
```

M 返工必须产生新 HEAD，V/R 重试必须产生新 Evidence。实现与证据返工共享最多 2 次预算；工具/环境重试单独计数。预算耗尽、重复失败、规格歧义或高风险会进入 `waiting_human_review`，并写入 `.spec-loop/conflicts/` 与可重建的 `.spec-loop/REVIEW_INBOX.json`，不能生成 Candidate。

真实 Codex 角色在首次运行或 Provider 语义身份变化后，会先执行最长 20 秒的同参数 runtime probe；probe 同时验证 UTF-8 locale、sandbox 和独立 Evidence 写区，并按二进制、版本、参数、角色和环境指纹缓存。运行中的 JSON usage 会持续计入角色/波次预算，达到 Token 或费用上限时终止完整进程组。Provider 可在独立 Evidence 目录写入 `RESULT.json`：合法结果由 Controller 自动摄入；缺失结果明确显示为 `awaiting_ingestion`，不会继续显示成运行中。

Scheduler Supervisor 和产物维护入口：

```bash
spec-loop scheduler control supervisor-start projects/demo --json
spec-loop scheduler control supervisor-status projects/demo --json
spec-loop scheduler control supervisor-launchd-plan projects/demo --json
spec-loop scheduler control supervisor-launchd-install projects/demo --apply --json
spec-loop scheduler control reconcile-waves projects/demo --apply --json
spec-loop maintenance retention-plan projects/demo --json
spec-loop maintenance archive-evidence projects/demo TASK-CHECKOUT-1 --json
spec-loop maintenance enforce-retention projects/demo --max-tasks 5 --json
```

`supervisor-launchd-plan` 只生成可审核的 macOS 配置和命令，不会自动安装；安装必须显式给出 `--apply`，已有不同内容的 plist 会拒绝覆盖。Supervisor 每天执行一次非破坏性 Evidence 归档（单轮最多 5 个 Task），排除可重建的候选快照并生成 SHA-256 manifest，不会自动删除历史或 worktree。npm/Maven 下载统一复用 Project 级 `.spec-loop/shared-cache/`，不再复制到每个 invocation。

默认波次预算为并发 2、20 分钟、25 万 Token、10 美元。并发任务先从同一全局余额中获得 reservation，实时 usage 会触发整波次熔断；Provider 连续 300 秒没有 stdout、stderr 或 usage 变化也会被判定为无进展。PID 与进程启动时间共同校验，停止采用 TERM→KILL 并验证退出，避免 PID 复用误杀。崩溃遗留的运行中波次可由 `reconcile-waves` 对账并明确标记为 `interrupted_requeued`。

M/V/R 默认使用同一个 Provider，也可以隔离配置，例如 `spec-loop providers set-role projects/demo --role V --provider claude-code`。目标 Provider 必须先在 `PROVIDERS.md` 启用；`providers set --active ...` 会把三个角色一起切换，避免默认 Provider 与角色映射互相冲突。

当前运行中的 v1 Task 继续使用 `TASK_STATE.md / VERIFY.md`；安装或构建新版本不会修改其状态，也不会自动重启已有 `view` 进程。

## 执行可视化（预览）

在任意已初始化 Project 中生成结构化快照，或打开本机只读页面：

```bash
node dist/cli.js snapshot projects/demo --json
node dist/cli.js view projects/demo
```

`view` 只监听 `127.0.0.1`。Dashboard Snapshot 硬限制为 256 KiB，每个 Task 只携带最近 20 个步骤；完整事实仍保存在 Event Log 和 Evidence 中。运行角色显示心跳、熔断剩余时间、实时 Token 和结果摄入状态。历史任务、当前运行、从未启动和仅有规格的 Task 使用不同标记；旧项目已有 Gate 的 `duration_ms` 继续显示为精确值，无法可靠还原的历史时间明确显示为“未记录”，不会使用文件修改时间猜测。

Round 内建议把活动拆成可计时步骤：

```bash
spec-loop activity start <task-dir> --kind reproduce --label "复现问题" --summary "稳定复现当前失败路径"
spec-loop activity finish <task-dir> --id <step-run-id> --outcome success
spec-loop activity run <task-dir> node backend/tools/run-task-141.mjs --label "TASK-141 定向验证" --summary "运行固定 MySQL 定向回归"
```

页面会分别显示复现、分析、修改、编译/测试耗时，并把没有子步骤事件覆盖的 Round 时间标记为“未拆分”，不会伪造历史明细。

目标规格配置：

| `--spec-profile` | 源码仓落点 | 用途 |
|---|---|---|
| `standard` | `spec/` | 兼容既有单规格库项目，默认值 |
| `backend` | `AGENT.md`、`spec/` | 后端服务与项目主规格库 |
| `frontend` | `AGENT.md`、`spec/` | 独立前端 Web 卫星规格库 |
| `fullstack` | `backend/AGENT.md`、`backend/spec/`、`frontend/AGENT.md`、`frontend/spec/` | 同仓全栈项目 |

例如 ERP 单仓全栈工程：

```bash
node dist/cli.js project init projects/independent-erp \
  --id PROJ-INDEPENDENT-ERP \
  --name independent-erp \
  --repository projects/independent-erp/repo \
  --spec-profile fullstack
```

初始化只补充缺失文件，不覆盖源码仓已有内容。新版模板中的项目基线字段需要在 Loop 0 填写；未填写时 `project spec-check` 会明确报告占位内容。

## Web 功能与视觉验收

Task/Loop 启动和普通修改反馈默认只进入快速预览，不代表授权正式交付。只有用户对当前稳定候选明确要求“进入正式验证”“进入正式交付”或“跑完整 Gate”后，才运行完整 Harness；效果被拒绝或候选继续变化后必须重新获得授权。阶段验收和进入下一阶段另行确认。

目标 Web 工程自行锁定 `@playwright/test` 和浏览器版本。项目控制目录的 `GATES.md` 可以声明：

```yaml
schema_version: 1
scope_kind: task
wave_id: W1
coverage: targeted
database:
  lifecycle: persistent
  reset: fixtures
gates:
  - id: web-e2e
    kind: playwright
    ac: [AC-1]
    timeout_seconds: 900
    config: playwright.config.ts
    tests:
      - tests/e2e
    projects:
      - chromium
    require_screenshots: true
```

`coverage: targeted` 是 Light/Standard Task 的强制默认值。只有整轮最终 Heavy Task
才可以使用 `scope_kind: wave` 与 `coverage: full`；Heavy 还必须至少配置一个
`evidence_class: mutation` 且 `stability_runs >= 2` 的 Gate。高波动行为也可设置 `stability_runs: 2` 或 `3`，任何一次失败都使 Gate 失败。`database.lifecycle:
persistent` 表示复用工程长期验证数据库，Gate 不得执行 `docker run/rm` 或
`docker compose up/down/rm`；迁移、初始化或升级/回滚类 Heavy 验证需要一次性
干净数据库时，改为 `disposable` 并填写 `reason`。

控制 Task 的 `ACCEPTANCE.md` 还必须声明同一个 Web Gate：

```yaml
web_gates:
  - id: web-e2e
    kind: playwright
    required: true
    ac: [AC-1]
```

Harness 会调用目标 worktree 中由 Git 跟踪锁文件约束的本地 Playwright，至少要求一项测试实际通过，并归档 JSON、HTML、适用的 PNG/trace/video 和逐文件哈希。`require_screenshots: true` 用于页面效果或截图契约；纯功能路径可显式设为 `false`，但不能借此跳过单独声明的人工视觉 Review。服务启动、`baseURL`、认证 fixture 等写在目标工程自己的 Playwright config 中。完整 Gate Plan（测试路径、配置、项目、grep、超时和截图策略）会被哈希绑定到 Evidence，执行后变化即失效。

视觉任务还应在控制 Task 的 `ACCEPTANCE.md` 声明：

```yaml
human_reviews:
  - id: REVIEW-1
    kind: visual
    required: true
    ac: [AC-1]
```

候选截图生成后执行：

```bash
node dist/cli.js review request tasks/example --id REVIEW-1 --revision <git-head> --evidence screenshot.png
node dist/cli.js review decide tasks/example --id REVIEW-1 --result approved --by zhangbo --note "效果符合预期"
```

Review 声明会在 `plan` 时冻结；决定历史使用连续哈希链。Review 未批准、被拒绝、截图变化、历史/投影被手改或真实 Git commit 变化时，正式 Verification 与 Delivery 都会被阻断。

规格库入口见 [spec/README.md](spec/README.md)，阶段路线见 [spec/roadmap.md](spec/roadmap.md)，系统模块和控制链见 [spec/architecture.md](spec/architecture.md)。
