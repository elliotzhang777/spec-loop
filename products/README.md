# Products 成品库

`products/` 是 Spec-Loop 管理的所有目标工程的本机最终成品统一出口。这里只放可以直接安装、运行或交给用户的版本化成品，不放源码、中间构建文件、测试缓存或原始 Evidence。

## 目录规范

```text
products/
└── <project-slug>/
    └── <version>/
        ├── <deliverable-file>
        ├── manifest.json
        └── SHA256SUMS
```

示例：

```text
products/concert-ticket-assistant/0.2.0/
├── TapFlow-0.2.0-universal-debug.apk
├── manifest.json
└── SHA256SUMS
```

## 收录规则

- `<project-slug>` 使用目标工程目录名；`<version>` 使用成品自身版本号。
- 成品必须已经完成与其风险相称的构建和定向检查，且能明确说明尚未完成的真机或人工验收。
- `manifest.json` 记录项目、版本、文件、类型、构建类型、兼容平台、SHA-256、生成时间、源码位置和验证状态。
- `SHA256SUMS` 使用标准 `<sha256>  <filename>` 格式。
- 已发布版本不可原位覆盖。任何内容变化都必须提升版本号或使用新的构建标识。
- 二进制和版本目录由 `.gitignore` 忽略；这里只跟踪本规范文件。长期发布建议再同步到正式制品库或 Release 服务。

## 与其他目录的区别

| 目录 | 用途 |
|---|---|
| `projects/` | 目标工程源码与项目内规格 |
| `.spec-loop/output/` | 运行状态、Gate 输出和 Evidence |
| 项目内 `build/`、`dist/` | 可重复生成的临时构建结果 |
| `products/` | 用户最终拿取成品的唯一入口 |

复制到 `products/` 只是“发布候选成品”，不自动代表 Spec-Loop 的正式 Verification、Acceptance 或 Delivery 已完成。
