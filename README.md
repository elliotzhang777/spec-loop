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
- Phase 3：Project metadata、项目多任务 Registry、Triage Proposal/Approval、Provider 配置、Git worktree、T1 Gate、Codex Harness 和 Project write-back（已完成）。

当前默认 Agent Provider 是 Codex；Claude Code 与 Qoder 使用同一 Provider 扩展边界。Phase 3 不包含后台 Scheduling、自动多 Round、自动 push/merge 或 Connector 写入。

## Install and build

```bash
npm install
npm run build
node dist/cli.js --help
```

## Quick start

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

See [spec/README.md](spec/README.md) for the specification library and [spec/roadmap.md](spec/roadmap.md) for the product roadmap.

## Current capability

The implemented baseline is:

```text
Light / Standard / Heavy task governance
+ A0 protocol-driven execution
+ T0 externally supplied engineering evidence
+ D0 local Delivery record
```

Project Loop 和 Codex 受控单步执行已完成；自动工程 Toolchain 平台预设（Spring Boot、Xcode、微信小程序）、受控 Scheduling、自动多 Round 和 Portfolio 属于 Phase 4–5，尚未实现。
