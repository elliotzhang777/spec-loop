# Target Spec 模板资产

本目录是 Spec-Loop 目标工程规格初始化模板的唯一事实源。每个版本目录包含版本清单；该清单定义完整文件集合、角色和占位检查策略，`project init`、`project spec-init` 与 `project spec-check` 必须共同加载它。

- `v1`：兼容模板版本 `1.0.0`；
- `v2`：`standard` 模板版本 `1.1.1`；
- `v3`：从 `spec-template` 吸收的分工程模板，当前版本 `2.0.2`，包含 `backend` 主规格库与 `frontend` 卫星规格库，可组合为 `fullstack`；Task/Loop 启动默认停留在快速反馈，非 Heavy 只运行定向 Gate，默认复用长期验证数据库，正式验证和阶段推进需要显式授权。
- `v4`：当前分工程模板版本 `2.0.3`；在 v3 目录结构上补充锁文件约束的 Playwright Gate、条件截图策略和绑定 revision/截图哈希的人工视觉 Review，v3 保持不可变用于兼容追溯。

已发布版本只做兼容修正。任何改变目标结构或默认内容的演进都应建立新版本目录，并同时增加初始化、补缺、不覆盖、清单完整性和检查器兼容测试。
