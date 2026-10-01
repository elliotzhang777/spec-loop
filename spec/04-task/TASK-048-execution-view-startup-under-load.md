# TASK-048：全量负载下后台执行视图启动超时

- 状态：已完成
- 风险等级：standard
- Spec-Loop Task：.spec-loop/tasks/task-048
- Proposal：PROP-19
- 协议版本：P/M/V/R v2
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-09-30
- 最后更新：2026-09-30
- 所属设计：[DES-009](../03-design/DES-009-execution-visualization.md)
- 所属特性：[FEAT-009](../02-feature/FEAT-009-execution-visualization.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 关联工单：TASK-029（同一集成候选复验，非受管启动依赖）
- 来源轮次：第五轮，TASK-029 HEAD `4f7fb6e1c2c8d27fadb2ae8a0ca85a0c93e7514f`
- 工单类型：验证发现的生命周期缺陷

## 问题与证据

TASK-029 受管 WEXEC-VIEW full Gate 在 321 个 Node 用例中 320 PASS、1 FAIL。唯一失败为 `test/execution-view.test.mjs:661` 的后台执行视图生命周期用例：`startManagedExecutionView(root, 0, {timeoutMs:4500})` 在全量负载下未能于 4.5 秒内确认健康，返回 `execution view did not become healthy within 4500ms`。独立定向重跑耗时约 1.35 秒并通过，说明需要诊断并发负载中的启动路径和测试时限，不能凭一次定向 PASS 关闭。

原始失败日志：[第五轮全量日志](../../.spec-loop/output/ROUND5-4f7fb6e-heavy-failed-archive/TASK-029-gate-execution-view-heavy-full.txt)，`not ok 84`；同轮其他六个 Heavy Gate 均 PASS。TASK-029 AC-6、AC-7 保持 FAIL，R 不启动。

## 工作范围

- 定位 5 秒交互启动门槛下，进程身份探测、marker 与健康探测在并发负载中的耗时来源。
- 修复生产启动路径或测试中的真实竞态；保留进程身份验证、僵尸 marker fail closed、端口冲突与停止时不误杀的安全边界。
- 在新集成 HEAD 定向复测生命周期、安全与端口冲突，再重跑 TASK-029 原批准的七组 Heavy Gate。

## 验收标准

- [x] AC-1：受管后台视图在批准的交互启动门槛内就绪，重复启动复用同一进程；并发负载不触发固定时限误失败。
- [x] AC-2：身份不明或 marker 异常仍 fail closed；端口冲突、停止和清理用例通过，不遗留错误 marker 或误杀无关进程。
- [x] AC-3：同一新集成 HEAD 的 `quality:standard` 至少 321 个 Node 用例及 TASK-029 七组受管 Heavy Gate 全部 PASS，保留旧 FAIL 和新 Evidence。

## 验证范围

定向 `test/execution-view.test.mjs`、`test/view-auto-open.test.mjs` 和启动安全场景；最终 full 复测归 TASK-029 Heavy。

## 收口证据

候选 `75a9c915bff37d4c8869b6209fae7c814bd0f4dd` 的受管定向 Gate 2/2，其中执行视图用例 32/32，独立 V/R PASS；相关实现和测试与集成 HEAD `246cecdc6ee1f0d2862a85e12600aecb5a652d84` 内容一致。该集成 HEAD 的 TASK-029 七组 Heavy Gate 及 Node 322/322 PASS；第五轮 `not ok 84` 原始失败仍归档。见 `.spec-loop/tasks/task-048/ACCEPTANCE_RUN.json`、`.spec-loop/output/TASK-048-gates.json` 和 `.spec-loop/output/TASK-029-gates.json`。实现通过并行启动身份探测与健康轮询缩短关键路径，身份不明时的清理检查保留。
