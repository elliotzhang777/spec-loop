# TASK-031：v2 验收契约接入与新任务默认协议

- 状态：已完成
- 优先级：P0
- 负责人：Codex
- 创建日期：2026-09-04
- 最后更新：2026-09-29
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 依赖工单：TASK-030 正式通过独立 V/R
- 任务等级：Standard
- 协议版本：P/M/V/R v2
- 所属批次：P4-B2

## 目标

让新建 Task 在 P 阶段同步形成完整、可批准、可哈希的 v2 验收契约，并在显式开关下成为新任务默认协议；历史 v1 在途任务保持原协议。

## 工作范围

### 包含

- Product/Feature/Design/Task 与 `ACCEPTANCE_CONTRACT_V2.md` 的同步生成和一致性检查；
- AC、用例、工具、命令、断言、Evidence、风险、依赖和关键路径完整性校验；
- Proposal Approval 绑定规范化 contract hash；
- 新任务默认 v2 的项目级开关、doctor/status 输出和回滚入口；
- v1 已开始任务、已交付任务及旧模板的兼容读取；
- 本仓库与新发布的目标工程 v5/v6 模板同步；已发布 v1～v5 保持逐字节不可变并继续可读。

### 不包含

- 自动启动 M/V/R；
- Scheduler、并发 Worker、自动 merge/push/deploy；
- 把 TASK-027、TASK-028 等在途 v1 Task 强制迁移到 v2。

## P/M/V/R 职责

- P：生成完整契约并提交人批准，不能在实现后降低断言。
- M：本工单唯一代码写角色，只实现契约生成、校验和默认协议开关。
- V：独立验证契约篡改、批准失效、v1 兼容和模板一致性。
- R：在 V PASS 后复核全部 AC、Evidence hash 和协议边界。

## 验收标准

- [x] AC-1：创建 v2 Task 时一次生成完整契约，缺失任一 AC 的用例、工具、断言或 Evidence 要求即失败。
- [x] AC-2：Approval 精确绑定规范化 contract hash；内容、版本或批准有效期变化后旧批准不可继续使用。
- [x] AC-3：项目可显式开启或关闭“新任务默认 v2”，切换不迁移、不改写、不重启任何既有 v1 Task。
- [x] AC-4：目标工程 v5/v6 模板和本仓库模板表达相同的 P/M/V/R、验证时机与权限边界；旧发布摘要不变。
- [x] AC-5：doctor/status 清楚报告项目默认协议、每个 Task 协议与阻塞原因。
- [x] AC-6：回滚默认开关后仍可读取已有 v2 Run，且不得把运行中的 v2 降级为 v1。

## 验证计划

| 验收标准 | 验证方法 | 预期结果 |
|---|---|---|
| AC-1～AC-3、AC-5～AC-6 | 定向 CLI、Schema、篡改与兼容测试 | fail closed，协议状态确定 |
| AC-4 | 模板 manifest、hash 与 spec-check | 本仓库和目标模板一致 |

## 验证范围

- `scope_kind: task`，`coverage: targeted`，数据库 `persistent/fixtures`。
- 已批准工单范围内，稳定候选的定向正式 V/R 随执行授权连续推进；候选变化后重建 Evidence，不重复申请执行授权。最终 Heavy、阶段验收及外部动作仍另行决定。

## 实现与快速反馈记录

- 已增加项目级 `default_task_protocol` 开关及 `project protocol/status/doctor`、任务协议与阻塞原因输出。
- v2 Proposal 必须携带完整 P 契约；Proposal Approval 对包含契约的原始内容计算 hash，创建 Task 时生成获批 `ACCEPTANCE_CONTRACT_V2.md`。
- 切回 v1 只影响后续 Proposal；现有 v1/v2 Task 不迁移、不改写，v2 工件保持可读。
- 新增不可变目标模板 v5（`2.1.0`），保留 v1～v4 原摘要；后端与前端 Task 模板均包含 P/M/V/R、验证时机和权限边界。
- 2026-09-04 快速反馈：`npm run build` 通过；`node --test test/project.test.mjs test/target-spec.test.mjs` 17/17 通过。尚未执行正式独立 V/R。

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-09-04 | 创建并批准 | 将最新版架构中的 P 契约和 v2 新任务接入拆成独立可验收工单 |
| 2026-09-04 | 实现候选进入待验证 | 默认协议、v1/v2 兼容、doctor/status、v5 模板及定向测试完成 |

- 2026-09-26 快速反馈：依据用户“统一最后确认”要求新增目标模板 v6（2.1.1）；按批准 Task/波次持续执行授权，HEAD 变化重建 Evidence 而非重复请求 V/R，最终验收/外部动作集中明确决定。v1～v5 发布摘要保持原值，初始化继续只补缺不覆盖既有工程约定；海工工程前后端规则由本次明确修改同步。
- 本次快速反馈：TypeScript 编译与目标模板/初始化/兼容/不覆盖/规格检查定向测试 12/12 通过；旧发布模板摘要未变化，未运行全量回归或业务 V/R。
- 2026-09-29 独立 V 对候选 `eb05e92` 判 FAIL（AC-2/5）：修改过期 Approval 的有效期后旧批准可重用；损坏已批准 Contract hash 后 doctor/status 未报告阻塞。报告 `.spec-loop/output/TASK-031-V-eb05e92.json`；构建与定向测试 20/20 通过，但对抗复现阻断验收。
- `aba8744` 独立 V 再次判 FAIL（AC-2）：批准 JSON 和同目录摘要均可改写，旧批准仍能创建 Task 并启动 Run；报告 `.spec-loop/output/TASK-031-V-aba8744.json`。最终修复以项目目录外、权限为 `0600` 的本机批准密钥签署记录，项目目录内同时改写 JSON 与摘要不能伪造有效批准；规范化 Contract hash 仍绑定在批准记录中。历史 v1 记录仍按旧格式读取。doctor/status 校验已批准 Contract 的完整性及 Run 绑定。
- 2026-09-29 最终候选 `7177a72` 独立 V/R 均 PASS（AC-1～6）：`.spec-loop/output/TASK-031-V-7177a72.json`、`.spec-loop/output/TASK-031-R-7177a72.json`；构建与合并定向测试 52/52、独立 R 6/6 通过，双文件批准篡改、协议降级、Contract/Run hash、v1 兼容与 v2 回滚均复验。本机密钥丢失或更换会让旧 v2 批准失效，需要重新批准；完整 Phase 4 Heavy 与真实多 Provider 留给后续工单。

- 2026-09-29 在最新隔离角色候选 `7233571` 上重新通过独立 V/R（AC-1～6）：`.spec-loop/output/TASK-031-V-7233571.json`、`.spec-loop/output/TASK-031-R-7233571.json`。

- 2026-09-29 在 Spring Gate Planner 最终候选 `af57702` 上独立 V/R 重绑 PASS（AC-1～6）：`.spec-loop/output/TASK-031-V-af57702.json`、`.spec-loop/output/TASK-031-R-af57702.json`。

## 关闭检查

- [x] 验收标准全部通过，独立 V/R 最新绑定 `af57702`
- [x] 测试、设计差异与本机密钥限制已记录
- [x] Design、Feature、Product 已同步
- [x] 已从两个看板移除
