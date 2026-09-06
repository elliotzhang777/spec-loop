# 2026-09-06 Supervisor 与 Provider 防卡死专项验证

## 结论

本轮只验证 Spec-Loop 引擎，不启动目标业务项目波次。独立 Supervisor、波次熔断、角色隔离、仓库布局和当前 Evidence 绑定已形成正式 Candidate；真实 Codex Provider 的外部稳定性不被伪造为通过。

## 已绑定事实

- 隔离控制工程：`/tmp/spec-loop-formal.U7hNFU/control`
- 正式 Task：`TASK-043`
- Candidate：`CANDIDATE-TASK-043-1788679012336`
- Candidate HEAD：`fa56a3960bf637faf42a497c909add166c9d8afb`
- Contract hash：`a8ea544172fc0c9e303536c4d261ccd794e0769762d3f0b4d225ed08d3b331e6`
- Plan hash：`eee3aef346903293a838a1c6c7636b9c5815bf4256afdf08945cfbcff2ef20e2`
- V Evidence set：`55f3d0f876b44163fb875f1f06b4c4a2bf1953bdcf3ce91d0a9fd236c2cc32c6`
- R Evidence set：`45645d65c2a347a62f1d2645820854ee797f8142f11096ea161bb97c46ea9984`
- Evidence archive manifest SHA-256：`f482448ef1869fe51cccb0f032a228fcd6a405ed3570faacfee139784fa957b2`
- Evidence archive 大小：`28269` bytes；归档命令重复执行保持幂等

## Gate 与故障注入

- M 自测：Supervisor 3/3、启动/角色/布局 4/4。
- Controller Gate：同一 HEAD 上全部通过；独立 V PASS，独立 R 校验 V Evidence hash 后 PASS。
- 真实 Codex V 在 180 秒波次预算处触发熔断；`TASK-042` 原子取消并保存停止 HEAD，没有生成虚假 PASS。
- 后续新增 runtime probe、在线 usage 熔断、结果自动摄入、完整进程树终止、Snapshot 256 KiB 上限和 Evidence archive，使用本地对抗 Fixture 验证；不把 Fixture 的零 Token 结果当作真实 Provider 用量。

## 未执行

- 未 merge、push、deploy。
- 未安装环境依赖。
- 未删除历史 `.spec-loop` 产物。
- 未启动任何目标业务项目波次。
