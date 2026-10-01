# TASK-051：Proposal 内嵌未完成占位内容未被拒绝

- 状态：已完成
- 风险等级：light
- 优先级：P1
- 负责人：Codex
- 创建日期：2026-10-01
- 所属设计：[DES-004](../03-design/DES-004-controlled-automation-controller.md)
- 所属特性：[FEAT-004](../02-feature/FEAT-004-controlled-automation.md)
- 所属产品：[PROD-001](../01-product/PROD-001-local-spec-loop.md)
- 关联工单：TASK-045 AC-2
- 来源轮次：第六轮，TASK-045 候选 `74796dae29524a314907ba94ba824bcaa9f343e7`
- 工单类型：独立 R 发现的产品缺陷

## 问题与证据

TASK-045 的定向 Gate 编译和 9/9 项目测试通过，但独立 R 在 `src/files.ts` 的内容检查中发现 `验收步骤：待填写。` 与 `The validation strategy is TBD.` 会被当作已填写内容。占位指令只在字段开头检查；`src/project.ts` 的 Proposal 入口复用此检查，因此内嵌的未完成内容可进入 Proposal。原始复核为 `.spec-loop/output/TASK-045-acceptance-v2/invocations/INV-TASK-045-R-87df5ea5-c8b3-452c-82a5-665f4a355902/evidence/REVIEW.md`。该 R 调用随后因累计 token 限额终止，正式 R 尚未摄入；缺陷结论不得被旧 V PASS 覆盖。

首次修复候选 `e0c933832ec49013280784726736bcf132f5c560` 让上述两个短例被拒绝，但新独立 V 继续复现 `The validation strategy is TBD pending review.` 与 `验收步骤：待填写（负责人确认后补充）。` 仍被接受。证据为 `.spec-loop/output/TASK-045-acceptance-v2/invocations/INV-TASK-045-V-6654cd40-23a0-4ae2-874d-ef14ea5d2876/evidence/REVIEW.md`。两组问题属同一占位判定根因，合并在本工单；下一候选必须覆盖带后缀的形式。

第二次修复候选 `a4e264ea83672edb21ac972eee0178253979a3ae` 让带前缀的长例被拒绝，但独立 V 又发现字段直接以 `待填写（负责人确认后补充）。`、`TBD pending review.` 或 `TODO implement criterion` 起始时仍被接受。该 V 的受管摄入合并了 Provider FAIL 与 2/2 Gate PASS，正确进入 `CONFLICT-TASK-045-1790787621947`；证据位于 `.spec-loop/output/TASK-045-acceptance-v2/invocations/INV-TASK-045-V-e6d2f995-1ffb-45be-959a-ff8928196a56/evidence/REVIEW.md`。这些仍是同一占位判定根因，不另建重复缺陷。

第三次修复候选 `bc648f14b35ee6f178ca10eb8c2a0bfe1379fcba` 用宽泛的解释性句首白名单放行了 `TODO is pending review.`、`TBD is pending review.` 和 `TODO must be implemented before acceptance.`。独立 V 在 `INV-TASK-045-V-2256fccd-ec0b-44f6-8222-95468e719adb` 明确判为 AC-2 FAIL，合并受管 Gate 后退回 M。这些仍归入同一根因；下一修复须将确实解释占位词的句子与未完成动作区分开。

第四次修复候选 `9de5216adba969567c84c31bc33e8edc106f6984` 将上述句首动作正确拒绝，但独立 V 发现 `TODO（负责人确认后补充）。` 和 `TBD(implement criterion)` 仍可通过：英文直接占位词的边界没有覆盖中英文左括号。证据为 `INV-TASK-045-V-90078dd1-5d29-4f55-812e-837ddaf2882f` 的 `RESULT.json`/`REVIEW.md`；受管 V 合并 Gate 后已退回 M，累计语义返工 2/2。

第五次修复候选 `611ee8c2e5bbc0d40af244506a65afe458802c31` 修复了句首括号，但内嵌的 `The validation strategy is TBD(implement criterion).` 与 `The validation strategy is TBD（负责人确认后补充）。` 仍可通过。独立 V `INV-TASK-045-V-b468ab3b-f8ef-450c-bb04-a86289648225` 判定 AC-2 FAIL，受管摄入后产生 `CONFLICT-TASK-045-1790789413221`；该冲突已按授权续做决议保留历史并重启返工。

第六次修复候选 `fa16860dca90278a9ca726fba6382889a38ff7f9` 已覆盖括号边界，但独立 V 发现自然语言形式 `验收步骤待填写` 与 `The validation strategy stays TBD.` 仍会通过。证据为 `INV-TASK-045-V-289bc5f0-3044-4050-bd7f-5c6c2886576f`，受管 V 已把失败退回 M。逐个扩充标点规则仍遗漏完整句中的未完成标记；下一实现应统一识别显式 TODO/TBD/待填写标记，并为确实讨论标记规则的完整句子保留窄例外。

第七次修复候选 `5f7af491698ef659fa6d7dcb2783ef9df69e2831` 已按句段识别标记，但同一句段的解释性 TODO 会错误豁免另一处未完成 TBD：`TODO is a placeholder term and the validation strategy is TBD.` 被接受。独立 V `INV-TASK-045-V-a795abbe-810e-4e70-8bd6-eb324e8d02c8` 判定 AC-2 FAIL，受管摄入后退回 M。下一实现须逐次检查每个标记，不能用一个解释性提及豁免同句段中的其他未完成标记。

第八次修复候选 `f8fe53fe73907c340d1eded5fdce29f38fce6f31` 解决混合 TODO/TBD，但独立 V 发现 `placeholder: acceptance steps to be completed after review` 和 `fill me with the acceptance steps after review` 仍被当作实质内容。这些也是原 AC-2 的显式未完成指令。证据为 `INV-TASK-045-V-8a22c822-0581-4607-98bc-eff91158fa43`，受管 V 后冲突 `CONFLICT-TASK-045-1790791348932` 已按授权续做决议保留历史。

第九次修复候选 `e8a94714f22dc753d5fd24cff7d3202ee56cf66c` 已拒绝直接 `placeholder:` 与 `fill me`，但独立 V `INV-TASK-045-V-4f0bf35a-4939-423a-8e4b-605c8bc9d404` 发现 `The acceptance steps are placeholder pending review.` 仍通过。该 V 受管摄入后退回 M；下一修复需覆盖系动词后的 `placeholder`，并保留 `TODO is a placeholder term` 这类对术语本身的解释。

后续候选 `1a316d86e3ead2ef94f157c829b9c75c5451e478` 已覆盖单数形式，但独立 V `INV-TASK-045-V-10256762-a546-4899-adec-3bc98c6c41cb` 发现 `The acceptance steps are placeholders pending review.` 仍通过。新候选 `8ed8b89ae339ea1edde3eada46d115d7c5d97611` 已覆盖复数，并通过定向构建、9/9 项目测试与受管 V；独立 R 尚待完成。

## 工作范围

- 在 `src/files.ts` 区分内嵌的未完成占位内容与完整句子里对占位术语的解释。
- 在 Proposal 入口新增复现用例，保留 TASK-029 原 Contract 和合法 `unknown` 精度文本的通过结果。
- 修复进入下一轮同一新候选，按 TASK-045 批准计划重做 V/R，并纳入全规格库适用矩阵。

## 验收标准

- [x] AC-1：上述全部形式，以及 `验收步骤待填写`、`The validation strategy stays TBD.`、`TODO is a placeholder term and the validation strategy is TBD.`、`placeholder: acceptance steps to be completed after review`、`fill me with the acceptance steps after review`、`The acceptance steps are placeholder pending review.`、`The acceptance steps are placeholders pending review.` 等自然语言内嵌的显式未完成内容，在 Proposal 入口被拒绝。
- [x] AC-2：完整的 `unknown` 领域描述和说明 TODO/TBD/待填写规则的完整句子仍可通过。
- [x] AC-3：TASK-045 的定向 Gate 与独立 V/R 在新 HEAD 上通过，旧 V/R 与失败证据保留。

## 收口证据

同一根因的修复已纳入 TASK-045 候选 `8ed8b89ae339ea1edde3eada46d115d7c5d97611`；定向 Gate 2/2、Proposal 项目测试 9/9、独立 V/R 均 PASS。逐项失败与复验轨迹见 TASK-045 的受管 V/R 历史和本工单上方记录。解释占位规则的完整句与 TASK-029 原 `unknown` 文本保留通过；实现和批准设计一致，无视觉验收范围。
