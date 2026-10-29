# 第四轮 C4-VERIFY：投标材料核验服务端闭环 — 实施与验证记录

- 任务：`task-7`（R4-C4-VERIFY），负责人 Agent B（agent-c4-verify）
- 分支/HEAD：`alaaladaka/round4/verification` @ `c9ac2bb`（W0 冻结已提交）
- 日期：2026-10-29
- 依据：`docs/superpowers/plans/2026-10-29-round-four-plan.md` §4.2/§4.3/§4.6/§4.7/§4.9、§5 C4-VERIFY；`spec/01-product.md` §4.3、§6.1、§8.2.3、§9.3、§12 AC-04/08/14/21/22
- 提交状态：**未执行 `git add`/`git commit`**；全部改动留在工作树，由 Lead 按路径隔离提交。

## 1. 交付范围（写作用域内）

新增（均为未跟踪文件）：

| 文件 | 作用 |
| --- | --- |
| `src/lib/business/verification-types.ts` | 客户端安全的要求集/核验结果 value、两组状态、运算符、外部记录视图契约 |
| `src/server/verification/types.ts` | 受控失败码与固定文案、记录/证据规范化摘要、通用解析小工具 |
| `src/server/verification/requirements.ts` | `parseRequirementCandidates`、`bidRequirementSetValidator`、`assertReadyForComparison`、快照映射 |
| `src/server/verification/compare.ts` | 纯确定性比较：eq/neq/in/not_in/lte/gte/on_or_before/on_or_after/contains、单层 AND/OR、同主体约束、两组状态映射、coverage/unfinished |
| `src/server/verification/validation.ts` | `bidVerificationResultValidator`：结构、引用、记录完整性、映射一致性、状态/覆盖/未完成清单 |
| `src/server/verification/records-repository.ts` | 0010 `equilens_verification_records` 追加式读写，证据摘要幂等 |
| `src/server/verification/input.ts` | 按 manifest 重读材料版本/快照/片段/要求集版本/固定记录清单，复核归属、摘要、活动状态、保留期；bid-requirements 文本输入 |
| `src/server/verification/extractor.ts` | 生产 `BidRequirementExtractor`（服务端模型调用，≤2 次，JSON 候选解析，失败如实失败） |
| `src/server/verification/executor.ts` | `bid-verification`（maxCalls 0，确定性）与 `bid-requirements`（只提候选）执行器 |
| `src/server/verification/service.ts` | `VerificationService.saveRequirementSet`（服务端复核保存）、`recordExternalVerification`、`list`/`get`（含“记录/字段已更新，需重新运行”提示） |
| `src/server/verification/http.ts` | 4 个 HTTP handler 工厂：同源、严格白名单、限长、401/403/404/409/422/429/503、no-store |
| `src/server/verification/access.ts` | 生产接线：`requireAccount`/`requireProjectAccess`、production `ResultService`、A 的 `OcrRepository` 作为 `FieldSource`、项目保留期 |
| `src/server/verification/runtime.ts` | 显式 Node 生命周期 `startVerificationRuntime()` 注册两个执行器（导入不启动） |
| `src/server/verification/export-template.ts` | `bid-verification-report-v1` 导出模板（两组状态、原文/来源、记录元数据、未完成清单、AI/人工来源声明，`blocksInvalidResult: true`） |
| `src/app/api/projects/[id]/verifications/route.ts` 等 4 个 route | GET 列表、GET 详情、POST 要求集保存、POST 外部记录追加；均为 `runtime="nodejs"`、`dynamic="force-dynamic"` |
| 测试 10 个 + `verification-test-fixtures.ts` | `compare/requirements/validation/extractor/executor/service/http/export-template/closed-loop/field-integration` 测试与合成 SQLite fixture |

未修改（遵守禁止清单）：`spec/**`、`tasks/{catalog,admission,service}.ts`、`verification/{schema,field-source}.ts`、`lib/business/{verification-fields,contracts}.ts`、`results/**`、`exports/**`、`instrumentation.ts`、`package.json`、`migrations*`、`materials/**`、`reviews/**`、其它 Agent 文件。

## 2. 契约实现要点

- 要求集唯一写入路径：`VerificationService.saveRequirementSet` 重读每条要求的 `materialVersionId`、`snapshotId`、`fragmentId`，用共享 `quotesMatch` 逐字（规范空白）核对，校验材料活动/授权/保留期，组装 `sources`（片段原文）与 `dependencies`（material），最后调用 `ResultService.saveResultRevision(..., undefined, { serverOwned: true })`；普通成果 POST 对 `bid-requirements` 返回 FORBIDDEN（测试覆盖）。
- `bidRequirements` 候选：模型候选一律 `status: "pending"`、无法确定的 `nature` 为“待确认”，引文无法逐字定位的候选进入 `rejected` 且不保存演示要求；候选结果 `partial`，`assertReadyForComparison` 拒绝其用于比较。
- `bid-verification`：manifest 的 `requirementSet` 无 `projectId`，执行器经项目作用域 `ResultService.get` 读取并核对 `kind/versionId/sha256`；比较材料逐版本核对归属/摘要/活动/保留期；外部记录只读固定清单并重算摘要；比较不发起外部请求、`reserveCall` 0 次（测试断言）。
- 结果 value 内嵌：`requirementSet{id,versionId,sha256,requirements[]}`（含 quote/source/group）、`materials[{materialId,versionId,sha256}]`、`records[{recordId,sha256,...,requirementId}]`、`items[{materialCheck,externalCheck,detail,evidence[]}]`、`coverage`、`unfinished`、`warnings`、`errors`。
- 依赖：`kind:"result"`（要求集版本）+ `kind:"material"`（比较材料版本），导出保留期由 W0 扩展后的 `exports/access.ts` 读取。
- 两组状态独立：`status: partial` 仅由“材料检查待确认”决定；`材料缺失/字段冲突/日期不满足` 是确定性完成结论（可导出、可在 valid 时批准）；外部 `未核验/未查到/查询失败/待人工核验/记录冲突` 永不映射为通过，也不会把 valid 降为 invalid/partial（否则在无官方查询 API 时任何比较都无法批准，违背两组状态独立）。
- 外部记录匹配：仅当该要求**全部** `matched` 记录的查询主体与要求 `subject`（义务主体）一致、且主体/证号与比较证据（同 `subjectKey`）一致才为“人工查询记录匹配”；任一冲突/不匹配记录为“记录冲突”；`matched` 声明的映射一致性由 validator 独立重算。
- 低置信 OCR：`origin="ocr"` 且 `confidence` 非空且 `< 80` 的证据只能得到“待确认（字段待核实）”，不得满足或硬判冲突；人工/文本字段证据（confidence=null）与 ≥80 的 OCR 证据正常参与比较。置信度随证据内嵌，validator 校验 0—100 整数且仅 OCR 证据可带置信度。
- 判定时点：日期运算符带固定 `value` 时按固定日期比较；`value=null` 仅当 `asOfRule="task_as_of"` 时使用任务的显式 `asOf` 作为比较基准（绝不使用“今天”）；`asOfRule="not_applicable"` 不提供基准，该要求应为 pending/待确认，不能进入比较。validator 拒绝无基准的日期表达式。
- 排序与摘要：比较证据/覆盖/摘要排序使用 code-unit 比较（非 localeCompare），输出与平台无关；`evidenceDigest` 覆盖 confidence。
- 输入上限：生产 extractor 输入上限 60,000 字符，超出时在模型调用前以 `EXTRACTOR_FAILED` 失败（不静默截断）；bid-requirements 对 coverage 非 available 的材料在候选 value 中落固定 warning，任务结果保持候选/partial 并明确“不能视为全面资格要求检查”。
- 服务端保存上限：要求集最多 200 条、原始 value JSON ≤ 200,000 字符，超限返回受控 `INVALID_INPUT`（validator 同样拒绝超限快照）。
- 重跑：每次执行新建 resultId；旧成果可读、可复核、可导出。记录在成果保存后追加只影响新任务；详情/列表比较内嵌摘要与当前记录/字段，返回“记录/字段已更新，需重新运行”。
- 无效机器成果：仍由 `ResultService` 保存（origin machine、审计可读），执行器返回 failed + `RESULT_INVALID`；validate 为 invalid，approve 被拒、导出被 `blocksInvalidResult` 阻断（测试覆盖）。
- 未注册 kinds/未知资源：`GET /verifications` 只列两种 kind；详情对未知/跨项目/非 C4 kind 统一 404；所有响应 `Cache-Control: private, no-store`。

## 3. 实际执行的命令与结果（仅记录真实执行）

| 命令 | 结果 |
| --- | --- |
| `pnpm exec tsc --noEmit` | exit 0（全仓无类型错误） |
| `pnpm exec tsx --test src/server/verification/compare.test.ts src/server/verification/requirements.test.ts src/server/verification/validation.test.ts src/server/verification/extractor.test.ts src/server/verification/executor.test.ts src/server/verification/service.test.ts src/server/verification/http.test.ts src/server/verification/export-template.test.ts src/server/verification/closed-loop.test.ts src/server/verification/field-integration.test.ts` | exit 0，**69 tests / 69 pass / 0 fail** |
| `pnpm exec tsx --test src/server/verification/*.test.ts`（含 C4-OCR 4 个测试文件） | exit 0，**106 tests / 106 pass / 0 fail** |
| `pnpm exec tsx --test src/server/verification/field-integration.test.ts`（A `OcrRepository` → B compare 联调） | exit 0，2/2 pass |

分文件计数（交叉复核修复后复测）：

| 测试文件 | tests | pass | fail |
| --- | --- | --- | --- |
| `compare.test.ts` | 14 | 14 | 0 |
| `requirements.test.ts` | 7 | 7 | 0 |
| `validation.test.ts` | 9 | 9 | 0 |
| `extractor.test.ts`（交叉复核新增） | 5 | 5 | 0 |
| `executor.test.ts` | 14 | 14 | 0 |
| `service.test.ts` | 8 | 8 | 0 |
| `http.test.ts` | 4 | 4 | 0 |
| `export-template.test.ts` | 3 | 3 | 0 |
| `closed-loop.test.ts` | 3 | 3 | 0 |
| `field-integration.test.ts` | 2 | 2 | 0 |
| **合计（B）** | **69** | **69** | **0** |
| C4-OCR 4 文件（A，供交叉复核） | 37 | 37 | 0 |
| **verification 目录合计** | **106** | **106** | **0** |

行为用例覆盖（对应 plan §5 C4-VERIFY 清单）：

- compare：正常/缺件/主体冲突/证号冲突/日期 asOf/日期用任务判定时点（无固定日期）与 not_applicable 待确认/单层 AND 同主体/单层 OR/嵌套与非确定条件待确认/补遗冲突待确认/文档诱导字段不通过/低置信 OCR 待核实（0/50/79/80/90、混合证据、AND 组）/确定性（同输入深相等、字段乱序不变、code-unit 排序）/外部状态逐项映射（未核验、未查到、查询失败、待人工核验、记录冲突、匹配、混用优先级）/matched 记录绑定义务主体/两组状态独立。
- requirements：候选逐字映射与 rejected、候选 partial、确认 valid、词表外字段/未知运算符/缺来源/嵌套组/日期运算符错配/已确认但性质待确认/空要求集/重复编号/非法补遗/非法 asOf 规则/无基准日期表达式 invalid、>200 条上限、`assertReadyForComparison` 三种拒绝原因、快照映射（含 subject）与字段集合。
- validation：valid/partial/invalid × 复核与导出矩阵（invalid 不可批准、partial 不可批准但可草稿导出，见 executor/closed-loop）、两组状态映射逐项、低置信待确认 partial、日期 asOf 基准、matched 义务主体绑定、证据置信度（越界/非整数/非 OCR 带置信度）、200 条快照上限、结构/引用/覆盖/未完成/记录完整性/额外键污染。
- extractor：>60,000 字符在模型调用前受控失败（无静默截断、0 次 fetcher 调用）、未配置模型 SERVICE_UNAVAILABLE、1 次预留调用解析 code-fence JSON 并上报用量、非法输出最多重试 1 次（含 maxCalls=1 边界）、上游 HTTP 失败如实失败。
- executor：成功保存机器成果与依赖、重跑新 resultId、撤权（不写）、保留期（不写）、旧令牌（CONFLICT）、要求集摘要不符/未确认拒绝、外记录 pin/未知/篡改拒绝、invalid 保存但任务 failed、bid-requirements 候选只 pending + 提取失败/空候选不保存 + 撤权/预算失败 + 超长文本调用前失败 + 部分解析覆盖固定 warning + 两次调用之间保留期失效。
- service：服务端复核保存（逐字来源、同版本快照、跨项目/失活/过期拒绝）、幂等与 409、普通 POST 不能写要求集、记录追加幂等/项目域/证明校验/旧成果不变、字段变化提示、kind 过滤与统一 NOT_FOUND、只读可读不可写、200 条/200,000 字符保存上限与边界 200 条成功。
- http：401/403/404/409/422/429/503、`private, no-store`（含错误响应）、同源、严格 body 白名单、只读、kind 过滤、未知/跨项目 404。
- closed-loop（无外部服务）：合成项目 → 假字段源/真实 SQLite 迁移 0010 → 要求集服务端保存 → `bid-verification` 任务（真实 TaskRepository claim + 执行器）→ validate valid → review approved → `bid-verification-report-v1` Word 导出 → 下载并核对对象 sha256；负例：缺字段为“材料缺失”非通过、补遗冲突 partial 只能草稿导出、invalid 审计成果导出被阻断。
- field-integration：真实 `OcrRepository` 写 OCR 运行/字段 → B compare 读到当前 OCR 值（置信度 90）并满足；人工更正后仅当前值参与比较（`字段冲突`），历史仍保留原 OCR 行；跨项目/跨版本 `values()` 为空。

## 4. 开发中实际发现并修复的问题

1. compare 初版外部记录匹配只按“任一条 matched”且证据池不含标识字段 → 改为“全部 matched 且同主体主体名+证号一致才匹配”，并把同版本主体名/证号标识证据并入条目证据，validator 可独立重算。
2. compare 初版 AND 组按条件全局求值，可能“名称来自甲证、证号来自乙证”误满足 → 改为同一 `subjectKey` 内求值（测试覆盖跨主体混合必须字段冲突）。
3. validator/compare 对 `unified_social_credit_code` 作为证号标识的口径不一致 → 统一纳入证号标识。
4. `validation.ts` 初版“材料缺失仍带要求字段证据”未拦截、`type` 额外键未拦截 → 增加证据存在性/污染键检查。
5. `input.ts` 外部记录证明材料校验初版存在无效比较表达式 → 改为统一 `activeMaterial` 复核；移除未使用导入。
6. 测试夹具需要在同一项目内连续 claim 任务（运行器单飞）→ 增加 `finishJob` 模拟统一 runner 终态写，重跑/多任务用例才可测。
7. executor 对注入 extractor 抛出的非受控错误初版返回 `RESULT_SAVE_FAILED` → 改为受控 `EXTRACTOR_FAILED`。
8. `extractor.ts` 未把 `onExchange` 传入请求层（tsc 报错，A 交叉复核指出）；`requirements/validation` 测试夹具缺 `group` 默认值（tsc 报错）→ 已修复，最终 tsc 0。

### 4.1 独立交叉复核（task-9）后的修复（已复测）

Lead 交叉复核结论 APPROVE WITH FIXES；以下 2 个 blocker + 6 个高价值项已在本轮修复并新增/更新测试：

1. **BLOCKER 1（静默截断）**：`extractor.ts` 原在 60,000 字符处静默丢弃后续招标段落（输入上限为 120,000）。改为在模型调用前以受控 `EXTRACTOR_FAILED` 失败，绝不截断后当作完整提取；新增 `extractor.test.ts`（>60,000 无 fetcher 调用；临界以下全量入 prompt）与 `executor.test.ts` 端到端用例（超长材料 → failed，未保存成果）。
2. **BLOCKER 2（部分解析覆盖未呈现）**：`bid-requirements` 执行器对 `coverage.status != available` 的材料在候选 value 的 `warnings` 中写入固定文案（`PARTIAL_COVERAGE_WARNING`：材料仅部分原文、不能视为全面资格要求检查），候选保持 `candidate`/`partial`；executor 测试覆盖。
3. **低置信 OCR**：compare 新增 `MIN_OCR_CONFIDENCE = 80`，低置信 OCR 证据只能得到“待确认（字段待核实）”，不得满足或硬判冲突；证据内嵌 `confidence`，validator 校验 0—100 整数且非 OCR 证据不得带置信度；compare/validation 测试覆盖 0/50/79/80/90、混合证据与 AND 组。
4. **locale 排序**：compare 证据排序与 `types.ts` 的 `evidenceDigest`/`recordListDigest` 改为 code-unit 比较；compare 测试增加 ASCII 大小写排序断言（跨平台稳定）。
5. **matched 记录绑定义务主体**：`mapExternalCheck` 增加要求 `subject` 参数；仅当记录主体规范化后等于要求义务主体（且主体/证号等于比较证据）才为“人工查询记录匹配”，否则“记录冲突”；`RequirementSnapshot` 增加 `subject`，validator 独立重算；compare/validation 测试覆盖主体不匹配与“仅角色名”情形。
6. **保存上限**：`saveRequirementSet` 在服务端复核前拒绝 >200 条要求或原始 value >200,000 字符（受控 `INVALID_INPUT`），`inspectRequirementSet` 与 validator 同样拒绝超限快照；service/requirements/validation 测试覆盖超限与 200 条边界成功。
7. **每次模型调用前重验保留期**：`bid-requirements` 执行器在 `onBeforeCall` 中重读项目保留期及所有材料活动/保留期，失效即 `RETENTION_EXPIRED`；executor 测试在两次调用之间使材料过期并断言失败且无成果。
8. **asOf 语义明确化**：日期运算符无固定 `value` 且 `asOfRule="task_as_of"` 时以任务显式 `asOf` 为比较基准；`not_applicable` 不提供基准（要求必须 pending/待确认，validator 拒绝该组合）。compare/validation/requirements 测试覆盖两种基准与固定日期优先。
9. Lead 在集成 lint 中修复的 3 处告警（executor 未使用 `now` ×2、validation.test 未使用 `item` helper）已保留，本轮修改未回退。

## 5. Lead 集成必须完成的接线（我未修改共享文件）

1. `src/server/results/registry.ts`：注册两个服务端校验器
   `["bid-requirements", bidRequirementSetValidator]`、`["bid-verification", bidVerificationResultValidator]`（分别从 `../verification/requirements`、`../verification/validation` 导入）。未接线时机器成果保存会因 `SERVICE_UNAVAILABLE` 失败。
2. `src/server/exports/template.ts`：`productionExportTemplates()` 注册 `["bid-verification", bidVerificationReportTemplate]`（`../verification/export-template`）。`bid-requirements` 不注册，导出保持 503（按计划无导出模板）。
3. `src/instrumentation.ts`：在 `startReviewRuntime()` 之后、`startTaskRunner()` 之前调用
   `const { startVerificationRuntime } = await import("./server/verification/runtime"); startVerificationRuntime()`。
4. `package.json` 测试路径：把本列表 10 个测试文件加入默认 `pnpm test`（`src/server/verification/{compare,requirements,validation,extractor,executor,service,http,export-template,closed-loop,field-integration}.test.ts`）。
5. 无需改 `results/access.ts`/`exports/access.ts`：W0 已提供 machine-only/server-owned 集合及按 `dependencies(kind=material)` 的保留期接缝；`access.ts`/`runtime.ts` 直接复用 A 的 `OcrRepository`（A 不要改名/改 `values()` 语义）。

## 6. 未运行项与未决风险

未运行（环境和任务约束内）：

- `pnpm check`（ESLint/Next 路由类型/tsc 全量）未运行；仅运行 `tsc --noEmit`。交叉复核指出并已修复 3 处 lint 告警（Lead 代修），但完整 ESLint 仍由 Lead 集成轮执行。
- `pnpm test`/`pnpm build`/`pnpm smoke`/`pnpm dev` 未运行（任务禁止；由 Lead 集成轮执行）。
- 浏览器/真实 HTTP 服务器验收未做（本轮无 C4 界面；路由仅经 handler 级测试与 tsc）。
- 真实模型、真实 OCR、OBS/MaaS/GaussDB 未调用；`bid-requirements` 生产 extractor 只经注入 fake transport 测试（含 prompt 上限与重试边界），未用真实账号验证提示词/JSON 稳定性。未验证真实调用计次与费用。
- 未跑 6 个封存投标案例，未做领域标注；AC-04 业务正确性、AC-08/AC-14/AC-21/AC-22 整项均不宣称通过。
- 0010 迁移只由已有 migrations 测试/A 测试覆盖 SQLite；GaussDB 语法与并发未验证。
- 生产 `exports/access.ts` 的真实保留期解析未在我的闭环中直接调用（闭环用同逻辑测试替身）；Lead 集成轮应做一次真实接线验证。

风险与诚实边界：

- `bid-requirements` 机器成果永远是 `partial`（候选未确认），这是设计而非缺陷；人工经服务端保存为 `confirmed` 后才可比较。
- `bid-verification` 的 `valid` 只表示“确定性比较完成且结构/引用/记录一致”，不代表投标人资格真实；external 匹配仅为人工记录匹配，不包装为官方实时查询。
- 低置信 OCR 阈值为固定 80（`MIN_OCR_CONFIDENCE`）：低于阈值一律待核实，不因“大概率正确”放行；媒体种类/字段差异的阈值标定需真实 OCR 样本验证（外部缺项）。OCR `confidence=null` 的历史字段按“无可信置信度信息”处理为可用证据，若后续要求更保守应改为待确认并单独登记。
- matched 记录绑定义务主体要求要求 `subject` 是具体主体名（如投标人公司名）；若模型/人工把义务主体写成“投标人”等角色名，人工匹配记录会显示“记录冲突”而非通过——这是刻意的保守行为，需在要求确认时录入具体主体名。
- extractor 直接使用 `ai/client` 的 `modelConfig` + 本模块内的服务端 fetch（`askModel` 固定 `max_tokens: 256` 不足以输出候选 JSON），未改动共享 `ai/client`；真实模型输出质量需在可用配置下验证一次，失败时不保存任何演示要求。
- requirements 结果 value 在计划列举字段外为支持单层 AND/OR 增加了 `group` 快照字段，为外部匹配绑定义务主体增加了 `subject`（计划“…”允许的必要扩展）；validator 同时接受字段比较与 group 二选一，拒绝二者并存与嵌套。
- 字段/记录提示只覆盖所比较材料版本上、要求涉及的字段（新增无关字段不误报）；这是刻意的最小范围。

## 7. 结论

C4-VERIFY 服务端闭环模块、HTTP 契约、校验器、导出模板与测试已按冻结契约交付，并完成 task-9 交叉复核的 2 个 blocker 与 6 个高价值修复；定向测试 **69/69**、verification 目录 **106/106**、`tsc --noEmit` exit 0。生产注册接线与全量门禁（check/test/build/smoke、真实服务/浏览器验收）属于 Lead 集成轮，未在本文宣称通过。未提交、未推送、未部署、未建 Issue。
