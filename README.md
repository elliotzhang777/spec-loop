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
- Phase 3：Project Loop 核心原型已完成；安全加固、故障恢复和完整 Harness Evidence 闭环已进入待验证，正式验收尚未完成。
- Web/UI：支持目标工程本地 Playwright 功能 Gate，以及绑定 Round、revision 与截图哈希的人工视觉 Review。

当前默认 Agent Provider 是 Codex；Claude Code 与 Qoder 使用同一 Provider 扩展边界。Phase 3 不包含后台 Scheduling、自动多 Round、自动 push/merge 或 Connector 写入。

## 工程结构

```text
spec-loop/
├── src/                   TypeScript 产品源码
├── test/                  自动化、对抗和恢复测试
├── assets/                运行时随包资产
│   └── target-spec/        目标工程规格模板
├── spec/                  产品、架构、工单和交付事实源
├── AGENT.md               协作规则
├── package.json           Node.js 工程配置
├── package-lock.json      依赖锁文件
└── tsconfig.json          TypeScript 构建配置
```

`dist/`、`node_modules/`、`.spec-loop/` 和 `.spec-loop-*-tx/` 是本地生成或运行目录，不是版本化的工程结构。历史测试输出和 Dogfood 按 Phase 归档在 [`spec/05-delivery/`](spec/05-delivery/)，不再占用根目录。

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
才可以使用 `scope_kind: wave` 与 `coverage: full`。`database.lifecycle:
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

Harness 会调用目标 worktree 本地 Playwright，至少要求一项测试实际通过，并归档 JSON、HTML、可完整解码的 PNG 截图、trace/video 和逐文件哈希。服务启动、`baseURL`、认证 fixture 等写在目标工程自己的 Playwright config 中。Web Gate 与 AC 的声明会在 `plan` 时冻结到 CLI 管理的 Task State 和状态历史；Gate PASS 会写入本轮原生 Evidence，未绑定该 Gate 的普通 Evidence 不能交付对应 AC。

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
