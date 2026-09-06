# TASK-038：统一最终成品出口

- 状态：待验证
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-09-04
- 所属设计：[DES-006](../03-design/DES-006-engineering-toolchain-adapters.md)
- 所属特性：[FEAT-006](../02-feature/FEAT-006-engineering-toolchains.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：无
- 任务等级：Light
- 协议版本：P/M/V/R v2
- 所属批次：独立目录治理

## 目标

为 Spec-Loop 管理的全部目标工程建立统一、稳定、可校验的本机最终成品出口，避免安装包散落在各项目临时构建目录中。

## 工作范围

### 包含

- 定义 `products/<project-slug>/<version>/` 目录契约。
- 定义 `manifest.json`、`SHA256SUMS` 与不可原位覆盖约束。
- 将当前点点助手 APK 发布为首个示例成品。

### 不包含

- 远程制品库、对象存储、自动上传或对外发布。
- 改变现有 Verification、Acceptance 或 Delivery 授权边界。

## 验收标准

- [x] AC-1：根目录文档和协作约定都将 `products/` 定义为最终成品唯一入口。
- [x] AC-2：成品按项目和版本隔离，并同时提供机器可读清单和 SHA-256 文件。
- [x] AC-3：二进制默认被 Git 忽略，规范文件可被版本控制。
- [x] AC-4：当前点点助手 APK 已从项目临时目录发布到统一目录且哈希一致。

## 验证计划

| 验收标准 | 验证方法 | 预期结果 |
|---|---|---|
| AC-1、AC-3 | `git check-ignore` 与文档检索 | 二进制被忽略、规范未被忽略，入口描述一致 |
| AC-2、AC-4 | JSON 解析、`shasum -a 256 -c SHA256SUMS` | 清单可解析，成品哈希校验通过 |

## 交付记录

- 完成日期：待正式验证
- 变更文件/交付物：`products/README.md`、根目录规范、点点助手 0.2.0 APK
- 遗留风险：当前只建立目录与手工发布约定，尚未实现 CLI 原子发布命令。

## 定向检查记录

- `manifest.json` 已通过 Node.js JSON 解析。
- `shasum -a 256 -c SHA256SUMS`：`TapFlow-0.2.0-universal-debug.apk: OK`。
- `git check-ignore`：版本目录内 APK 与元数据均命中 `products/*`；`products/README.md` 可被 Git 跟踪。
- 尚未获得正式 Verification/Delivery 授权，工单保持“待验证”。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 创建工单并开始实施 | 用户要求集中保存各项目最终成品 |
| 2026-09-04 | 完成目录规范、首个成品迁移和定向检查 | 形成统一最终成品入口 |
