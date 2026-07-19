# Target Spec 模板资产

本目录是 Spec-Loop 目标工程规格初始化模板的唯一事实源。每个版本目录包含一个 `manifest.json`；该清单定义当前版本的完整文件集合、角色和占位检查策略，`project init`、`project spec-init` 与 `project spec-check` 必须共同加载它。

已发布版本只做兼容修正。任何改变目标结构或默认内容的演进都应建立新版本目录，并同时增加初始化、补缺、不覆盖、清单完整性和检查器兼容测试。
