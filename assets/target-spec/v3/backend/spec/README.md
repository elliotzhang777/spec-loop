# 后端服务主规格库

本目录是后端工程中的项目主规格库，维护产品需求、总体架构、后端方案、执行和验证。配套的前端 Web 卫星规格库位于 [`../../frontend/spec/`](../../frontend/spec/README.md)，通过链接引用这里的正式规格。

## 目录结构

```text
backend/
├── AGENT.md
└── spec/
    ├── README.md
    ├── 00-conventions/
    │   └── development-guidelines.md
    ├── roadmap.md
    ├── architecture.md
    ├── pending-board.md
    ├── verification-board.md
    ├── 01-product/
    ├── 02-feature/
    ├── 03-decisions/
    ├── 04-design/
    └── 05-task/
```

正式信息沿以下链路逐步细化：

```text
roadmap.md -> 01-product/PROD-*.md -> 02-feature/FEAT-*.md
                                            |
architecture.md ----------------------------+
03-decisions/ADR-*.md ----------------------+
                                            v
                                  04-design/DES-*.md
                                            |
                                            v
                                    05-task/TASK-*.md
                                            |
                                            v
                                后端代码、配置、测试、文档
```

`architecture.md` 是项目级总体技术基线，记录系统边界、核心组件、数据与部署架构以及横切质量要求。每份 Design 都必须引用并遵循它；需要扩展或偏离时，应在 Design 中明确记录原因和影响，并同步更新总体架构中的关联设计或架构决策。

Product、Feature 和跨端业务验收口径由本目录维护。前端实现需要的页面行为或接口契约，也应先关联这里的 Feature 或 Design，避免在两个规格库中重复定义业务规则。

`00-conventions/development-guidelines.md` 是后端长期开发基线。`03-decisions/` 使用 `ADR-###` 保存影响多个特性或需要长期追溯的技术决策；局部实现细节仍放在 Design 或 Task 中。

## 两个看板

- `pending-board.md`：后端 `TASK` 与前端 `WEB-TASK` 共用的未完成执行队列。
- `verification-board.md`：两个工程共用的待验证队列。

看板是临时视图，不是历史档案。条目完成后必须先把交付结果和验证证据写回对应工单及受影响的上游规格，再删除看板条目。理想状态下，迭代结束时两个看板均为空。

## 推荐流程

1. 在 Roadmap 中登记目标。
2. 用 Product 模板描述产品问题和结果。
3. 用 Feature 模板拆分用户可感知的能力。
4. 补齐或确认总体技术架构，再用 Design 模板确定局部实现方式、接口契约和验证策略。
5. 用 Task 模板拆成可独立交付的后端工单，并加入待完成看板。
6. 若需要前端交付，在 [`../../frontend/spec/05-task/`](../../frontend/spec/05-task/) 建立关联的 `WEB-TASK`。
7. 按工单实现；实现完成后移入对应规格库的验证看板。
8. 验证通过，把证据写回工单，更新上游实际结果，清除看板条目。

每个目录中的 `_template.md` 用于复制新建文档，不应直接承载项目内容。
