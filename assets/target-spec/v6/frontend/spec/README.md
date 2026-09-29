# 前端 Web 卫星规格库

本目录是前端工程中的卫星规格库，只维护 Web 端的可执行工单、临时看板和长期开发规范。产品目标、业务规则、总体架构及接口设计以 [`../../backend/spec/`](../../backend/spec/README.md) 为准。

## 目录结构

```text
frontend/
├── AGENT.md
└── spec/
    ├── README.md
    ├── 00-conventions/
    │   └── development-guidelines.md
    └── 05-task/
        └── _template.md
```

## 信息流

```text
backend/spec/02-feature/FEAT-*.md
backend/spec/04-design/DES-*.md
后端任务/API 契约
              |
              v
frontend/spec/05-task/WEB-TASK-*.md
              |
              v
页面、组件、状态、测试和构建产物
```

## 使用原则

- 不在本目录复制 Product、Feature 或 Design；前端工单用相对链接引用主规格。
- 一个 `WEB-TASK` 应能独立实现和验证，页面范围过大时按用户可观察结果拆分。
- 页面结构、交互状态、响应式、无障碍、兼容性和测试要求在工单中具体化。
- 跨任务稳定生效的工程约定写入 [`00-conventions/development-guidelines.md`](00-conventions/development-guidelines.md)。
- 仅对单个任务有效的取舍写在工单中，不把临时实现细节升级成全局规范。
- 业务含义或接口契约不清晰时，回到主规格库补齐，不在前端侧自行创造第二套定义。

## 执行流程

1. 从上游 Feature、Design 或 API 契约创建 `WEB-TASK`。
2. 明确页面/路由、交互与数据状态、适配范围和验收方式。
3. 将工单加入后端主规格库的 [`pending-board.md`](../../backend/spec/pending-board.md)；开工后状态改为 `进行中`。
4. 按开发规范实现并完成自动化检查。
5. 需要独立验收时移入后端主规格库的 [`verification-board.md`](../../backend/spec/verification-board.md)。
6. 验证通过后把证据写回工单，同步上游实际结果并清除看板条目。
