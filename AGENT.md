# 规格驱动交付约定

本项目采用规格驱动开发。AI 和人工协作者必须以 `spec/04-task/` 中的工单为最小执行单位，以工单验收标准和 spec-loop Evidence 为完成依据。

## 开始工作前

1. 阅读 `spec/roadmap.md`，确认阶段、优先级和是否已经获准实施。
2. 阅读工单引用的 Product、Feature 和 Design。
3. 检查 `spec/pending-board.md` 与 `spec/verification-board.md`。
4. 如果需求还没有形成可执行工单，先完善上游规格，不直接实现模糊需求。
5. Phase 1–3 已完成；Phase 4–5 仍需依序获得实施授权和阶段验收，不得跳阶段或提前实现。

## 执行与交付授权

- 用户批准启动 Task、Loop 或“继续执行”，只授权规格范围内的实现、快速反馈检查和预览，不等于授权正式交付验证、阶段验收、Delivery、合并或发布。
- “改一下”“再看看”“出效果图”“打开预览”“效果不对”等反馈默认属于 `feedback`；只能运行最小充分的定向检查，不得启动完整 Harness、独立 Verifier、全量回归或重新绑定正式 Evidence。
- 只有用户对当前反馈批次明确说出“进入正式验证”“进入正式交付”“跑完整 Gate”或等价指令，Controller 才能进入 `delivery`。不得从历史授权、Task 等级或“更保险”推导授权。
- 正式验证授权只绑定当时的稳定候选。用户拒绝效果或候选继续变化后，授权立即失效并退回 `feedback`；再次进入 `delivery` 必须重新获得明确授权。
- `phase` 与“进入下一阶段”需要单独的阶段验收确认，不能由 Task 启动授权或 Task Delivery 自动推导。
- Light/Standard Task 的 Gate 必须使用 `coverage: targeted`，只覆盖自身 AC、改动模块和直接依赖；`coverage: full` 只允许最终 Heavy Task，业务波次完成后统一运行一次。
- 工程已经提供长期验证数据库时，Gate 必须使用 `database.lifecycle: persistent`，不得在每次验证中创建、删除容器或数据卷；使用事务回滚、固定 Fixture 或受控 schema reset 恢复数据。
- 一次性数据库只用于迁移、初始化、升级/回滚或隔离要求明确的 Heavy 验证，必须声明 `database.lifecycle: disposable` 和原因。
- Round 开始后，问题复现、根因分析和代码修改分别使用 `spec-loop activity start/finish` 记录；编译、定向测试和 Playwright 使用 `spec-loop activity run` 包装。不得把所有工作只留在父级 `round.work`，否则可视化只能显示“未拆分耗时”。
- 优先先完成复现和根因分析，再批量修改并运行一次最小定向验证；失败后按错误指纹决定是否再次运行，禁止无差别重复全量编译或回归。

## 规格层级

```text
Roadmap → Product → Feature → Design → Task → 实现与验证
```

- Roadmap：阶段方向和进入条件。
- Product：用户、问题、范围和成功指标。
- Feature：用户可感知能力与业务验收标准。
- Design：技术方案、接口、数据、风险和验证策略。
- Task：可独立实现、验证和关闭的最小工单。

下游文档必须引用上游 ID。需求变化从受影响的最高层开始更新。

## 完成定义

工单只有在以下条件全部满足时才完成：

- 验收标准逐项通过；
- 测试和检查结果已记录；
- 实际实现与设计差异已记录；
- 独立验证和必要人工检查已完成；
- UI、视觉、图标、页面布局或交互效果属于验收范围时，已完成绑定当前 Round、revision 和截图哈希的人工视觉 Review；
- 结果同步到 Design、Feature 和 Product；
- 两个看板不再保留该工单。

## 文档规则

- 项目相关的产品说明、架构设计、开发说明、实施计划、验证结论和阶段交付报告必须进入 `spec/` 对应层级，不得新增到项目根目录。
- 根目录只保留工程入口说明、协作约定和构建配置；`README.md` 不作为设计或交付事实源。
- 阶段交付报告统一使用中文文件名和中文正文，归档到 `spec/05-delivery/`。
- ID：`PROD-###`、`FEAT-###`、`DES-###`、`TASK-###`。
- 文件名：`<ID>-<kebab-case-name>.md`。
- 链接使用相对路径，一个概念只保留一个权威定义。
- 状态仅使用：`草稿`、`已批准`、`进行中`、`待验证`、`已完成`、`已取消`。
- 已完成工单不得删除；纠正时追加变更记录或建立新工单。
- Provider、Toolchain、任务治理等级和自动化等级是独立概念。
- Web 系统的功能 AC 不能只依赖编译或单元测试；应使用目标工程本地 Playwright 执行真实浏览器路径并归档报告、截图和哈希。人工视觉 Review 不能替代功能测试，Playwright PASS 也不能替代主观效果确认。

## 成品产出规则

- 所有目标工程可直接交付或安装的最终成品统一发布到根目录 `products/<project-slug>/<version>/`。
- 每个版本目录至少包含成品文件、`manifest.json` 和 `SHA256SUMS`；同一版本一经交付不得原位覆盖，修订时发布新版本。
- APK、IPA、DMG、EXE、ZIP、镜像导出包等二进制成品默认只保存在本机 `products/`，不提交 Git；`products/README.md` 是目录与元数据规范。
- 项目内的 `build/`、`dist/`、`.spec-loop/output/` 仍是临时构建或 Evidence 目录，不作为最终成品入口。
- 发布到 `products/` 不等于完成正式 Delivery；任务状态、Gate、Evidence 和人工验收仍按原流程管理。
