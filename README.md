# Spec-Loop

> Agent Loop 工程闭环系统，用于管理 Agent 工程任务的规格、执行、验证、迭代、验收和交付。

Spec-Loop 以本地工程和 Git 仓库为工作对象，把一次任务组织为：

```text
SPEC → PLAN → WORK → VERIFY → ITERATE → ACCEPTANCE → DELIVERY
```

目标工程始终是代码事实源；Spec-Loop 保存任务契约、生命周期、运行账本、预算、Evidence 和 Delivery，并通过 Guard、独立 Verifier 与人工门禁阻止无证据完成。

每个纳入 Spec-Loop 的目标工程还必须在自身仓库维护 `spec/` 规格库，按 `roadmap → product → feature → design → task` 组织业务规格。`.spec-loop/` 管理闭环运行，目标工程 `spec/` 管理系统本身的长期设计事实，两者不能互相替代。

## 当前能力

- Phase 1：Light/Standard/Heavy、文件契约、状态机、Round、AC、Evidence 和 Delivery。
- Phase 2：Attempt、Ledger、Budget、Guard、事实 Summary 和失败恢复。
- Phase 3：Project Loop 核心原型已完成；安全加固、故障恢复和完整 Harness Evidence 闭环已进入待验证，正式验收尚未完成。

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

规格库入口见 [spec/README.md](spec/README.md)，阶段路线见 [spec/roadmap.md](spec/roadmap.md)，系统模块和控制链见 [spec/architecture.md](spec/architecture.md)。
