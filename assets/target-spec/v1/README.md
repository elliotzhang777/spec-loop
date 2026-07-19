# 规格库使用说明

本目录是目标工程自身需求、方案、执行和验证的唯一事实源。Spec-Loop 的控制状态不复制或替代这里的业务规格。

## 目录结构

```text
spec/
├── roadmap.md
├── architecture.md
├── pending-board.md
├── verification-board.md
├── 01-product/
├── 02-feature/
├── 03-design/
└── 04-task/
```

正式信息沿 `Roadmap → Product → Feature → Design → Task → 实现与验证` 逐步细化；`architecture.md` 是所有 Design 的共同技术基线。

## 使用规则

- 两个看板是临时视图，不是历史或状态事实源。
- 每个目录中的 `_template.md` 只用于复制新文档。
- 已有规格不得由初始化或模板升级覆盖。
- 验证通过后，先把证据和实际结果写回正式规格，再清除看板条目。
