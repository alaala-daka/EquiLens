# EquiLens 第四轮并行实施计划（C4 投标材料核验，服务端闭环）

> 执行说明：本文件是第四轮实施计划，沿用[总计划](2026-10-27-three-person-development-plan.md)、[第二轮计划](2026-10-29-round-two-plan.md)与[第三轮计划](2026-10-29-round-three-plan.md)的工作包编号（C4，以及 C5/C6/C7/A5 的前置项）；不新增未经审查的产品契约，不是完成记录，不自动创建 Issue、推送、部署或发布。
> 基线：`alaaladaka/round3/review` @ `c74a2c2`（第三轮 A4c/B2a 与两次收口已合入，工作树干净）。
> 审查记录：本计划已由独立 reviewer 审查（报告 `.superpowers/round4/plan-review.md`，未跟踪），结论 REVISE；本版已按 BLOCK-1—BLOCK-5、N1—N18 修订：要求集改为服务端可复核保存、共享字段词表/归一化在 W0 冻结、0010 字段表改为可重跑/可多主体的插入式历史、补齐拥有规格、外部核验记录与字段状态进入任务输入清单、重跑语义改为新成果（新 resultId）。
> 本轮目标：交付 **C4 投标材料核验的服务端闭环**——要求候选（模型只提候选、人工确认）→ 材料字段（OCR 或人工登记、原文逐字核对）→ 确定性比较 → 两组状态独立 → 版本化成果与 Word 导出；同时建立诚实的 OCR 服务端边界（未验证即 fail-closed，图片材料默认拒绝）。C4 界面、C5 文书起草、C6 知识发布、C7 生命周期与 A5 平台验收在后续轮次完成。

## 1. 范围

**本轮交付（P0）**

| 包 | 所有者 | 内容 |
| --- | --- | --- |
| W0 | Lead | 规格增补、共享词表与归一化、任务目录三拆、任务准入钩子、迁移 0010 表结构、ResultService 服务端受控写入与 machine-only 集合、导出保留期接缝、分支与任务板 |
| C4-OCR | Agent A | 图片材料按 OCR 可用性门控（含上传意图终态与修复防重投）、`OcrAdapter` 服务端边界、`certificate-ocr` 执行器、OCR 运行/字段插入式历史仓储与字段接口、文本材料字段人工登记（同版本原文逐字校验） |
| C4-VERIFY | Agent B | 要求候选解析、服务端受控要求集保存、确定性比较、`bid-requirements`/`bid-verification` 执行器、结果校验器与导出模板、人工外部核验记录、HTTP 路由与纯逻辑测试、无外部服务的服务端闭环测试 |
| I1 | Lead | 集成、跨包审查、`pnpm check/test/build/smoke`、无外部服务闭环验收、证据、按包提交（不推送、不部署） |

**明确不在本轮**

- C4 界面（业务选择器、要求清单/材料对照/外部核验/结果页）→ 第五轮；本轮交付服务端契约、HTTP 与纯逻辑测试。
- C5 模板仓储与文书起草、C6 知识发布、C7 生命周期、A5 平台验收 → 第五、六轮。
- C6 的 `TaskManifest.publications` 与发布版本固定、B 线 B1a/B3a/B2b—B5、真实 OCR/MaaS/OBS/GaussDB、领域要求标注与规则签核、公网 HTTPS。

## 2. 分支与写作用域

共享工作目录，不并行 checkout。集成分支：`alaaladaka/round4/verification`（从 `c74a2c2` 建立）。
每个工作包独立提交；共享文件只能由 Lead 修改，Agent 需要改动共享文件时在报告中列出，由 Lead 合入。

| 所有者 | 独占写作用域 |
| --- | --- |
| Agent A（C4-OCR） | `src/server/verification/{ocr.ts,ocr-runtime.ts,ocr-repository.ts,ocr-executor.ts,ocr-test-fixtures.ts,ocr*.test.ts}`；`src/server/materials/{service,queued,repository,types,validation,parse,executor,runtime,upload-intents,http-runtime,http}.ts` 及其测试（图片门控、限制、上传意图终态/修复、无效解析防御）；`src/lib/business/materials-client.ts` 的必要时宽化；为 `MaterialFormat` 增加 `image` 引起的必要类型收窄（含 `src/server/reviews/input.ts` 的最小过滤，不改合同审查行为）；`src/app/api/projects/[id]/materials/[materialId]/versions/[versionId]/fields/route.ts` |
| Agent B（C4-VERIFY） | `src/server/verification/{types,requirements,compare,validation,records-repository,executor,input,extractor,service,http,access,runtime,export-template}.ts` 及测试（含 `field-integration.test.ts` 跨包集成测试）；`src/lib/business/verification-types.ts`；`src/app/api/projects/[id]/verifications/**` |
| Lead | `spec/**`、`src/lib/business/contracts.ts`、`src/lib/business/verification-fields.ts`、`src/server/verification/schema.ts`、`src/server/verification/field-source.ts`、`src/server/tasks/catalog.ts`、`src/server/tasks/admission.ts`、`src/server/tasks/service.ts`（仅准入钩子）、`src/server/tasks/test-fixtures.ts`、`src/server/database/migrations.ts` 与 `migrations.test.ts`、`src/server/results/{service,registry,access}.ts`、`src/server/exports/{template,access}.ts`、`src/instrumentation.ts`、`package.json`、文档、最终合并提交 |

## 3. 迁移编号（W0 冻结）

`migrateBusiness` 要求迁移编号从 `0001` 起连续（`src/server/database/migrations.ts:27-29`），当前只注册到 `0009`；第二轮计划中“0010=B1a facts、0011=B3a ledger”的预留从未注册（也未成为账本条目），无法直接跳到 0012。B 线本轮不在交付范围，由 Lead 在 W0 重新分配并登记：

| 编号 | 归属 | 表 |
| --- | --- | --- |
| 0010（本轮注册） | C4 | `equilens_ocr_runs`、`equilens_verification_fields`、`equilens_verification_records` |

- 0011（C6）、0012（C5）、0013（C7）仅为**后续轮次规划意图**，不是账本预留；每次落地取当时的下一个连续编号，并由该轮 W0 在计划与任务板登记。
- B1a/B3a 的 facts/ledger 表在 B 线真正实施时按当时下一连续编号追加，并把 `src/server/facts/repository.ts`、`src/server/payments/repository.ts` 中运行时 `initialize()` 建表迁入迁移账本；本轮不预建未使用表、不改 0001—0009 摘要。
- `.superpowers/round4/research-*.md` 中的迁移编号建议（C4=0012、C7=0010）已被本计划取代；历史评审记录不追改，本计划与第四轮任务板记录重分配事实。

## 4. W0 冻结接口（Lead 实现，A/B 消费）

### 4.1 规格增补（先改规格再实现）

- `spec/01-product.md` §4.3：追加项目接入段——要求集是项目的不可变成果版本且由服务端复核保存；比较由服务端确定性执行、不等待人工；两组状态独立展示与导出；OCR 不可用时生产拒绝证照图片。
- `spec/01-product.md` 新增 §8.2.3「项目投标材料核验成果」：`bid-requirements`（受控人工确认）与 `bid-verification`（机器基线）两种成果；要求集保存的服务端复核（逐字来源、同版本片段）；比较结果 value 必须内嵌要求集/材料/外部记录快照与两组状态；校验器 valid/partial/invalid 策略（结构/引用/记录完整性违规=invalid；未完成/待确认=partial；诚实外部状态不单独构成 invalid）；导出门槛（invalid 禁止导出、partial 以草稿导出）；**新增核验 HTTP 契约**（路径/方法/角色/no-store/跨项目统一 404/kind 过滤）；外部核验记录追加式语义与两组状态映射。
- `spec/01-product.md` 新增 §9.3「投标材料核验任务与 OCR 边界」：三个任务类型及 refs/conditions（含外部记录固定清单、`asOf` 必填、`certificate-ocr` 恰好 1 个图片版本、每个 OCR 任务最多 2 次请求、显式新任务重新计次并提示）、图片限制 4 MiB/8192 px/40 MP、未验证 OCR 时 `certificate-ocr` 不注册并 503、人工路径只接受同版本原文逐字核对或标记待确认、失败/部分结果不伪装成功。
- `spec/01-product.md` §9.1：把“只开放 material-parse”的过时表述改为执行器注册表规则与当前开放种类清单（material-parse、contract-review、本轮三种），明确未注册 kind 提交 503 且不入库；`certificate-ocr` 在 OCR 不可用时未注册。
- `spec/01-product.md` §6.1：补充图片材料的证据表示——图片材料不做 `material-parse`、不声称可编辑或已提取全文；OCR 运行与字段为不可变历史，人工更正另存并保留原值/理由；OCR 不可用时生产拒绝图片受理；字段与核验记录纳入项目删除/恢复清单。
- `spec/04-database-deployment.md`「业务 schema 迁移」：只登记 0010；说明 0011—0013 为规划意图、落地时取下一连续编号；OCR 运行/字段、核验记录为项目私有数据，发布版本为全局数据，分别进入 C7 删除清单与恢复范围。

### 4.2 共享字段词表与归一化（`src/lib/business/verification-fields.ts`，Lead 写）

```ts
export const VERIFICATION_FIELD_KEYS = [
  "subject_name", "unified_social_credit_code", "certificate_kind", "certificate_level",
  "certificate_number", "holder_name", "holder_id_number", "qualification_major",
  "registered_unit", "issue_date", "expiry_date",
] as const
export type VerificationFieldKey = (typeof VERIFICATION_FIELD_KEYS)[number]
export const VERIFICATION_FIELD_LABELS: Record<VerificationFieldKey, string>
export const VERIFICATION_FIELD_TYPES: Record<VerificationFieldKey, "text" | "identifier" | "date" | "enum">
export function normalizeFieldValue(key: VerificationFieldKey, raw: string): string
export function fieldValuesEqual(key: VerificationFieldKey, left: string, right: string): boolean
/** 规范空白后的引文匹配（spec §7.2：可规范空白，不能更改实质内容）。 */
export function quotesMatch(fragmentText: string, quote: string): boolean
```

- 归一化：NFKC、去首尾、折叠空白；`identifier` 去空白并大写；`date` 统一 `YYYY-MM-DD`（接受 `YYYY-MM-DD`/`YYYY.MM.DD`/`YYYY/MM/DD`/`YYYY年M月D日`，无法解析即拒绝）；不存在浮点金额键，金额需求不在本轮比较范围。
- A 的字段写入与 B 的要求/比较必须使用同一词表与归一化函数；B 的 `bidRequirementSetValidator` 拒绝词表外 `field`。

### 4.3 任务目录（`src/server/tasks/catalog.ts`，`TASK_CATALOG_VERSION` 2 → 3）

```ts
"bid-requirements": { maxCalls: 2, maxCostFen: 200,
  refs: z.object({ materials: materialRefs }).strict(),            // 1—10 份招标/澄清/补遗材料版本
  conditions: z.object({ asOf: day.optional(), externalProcessingConsent: z.literal(true) }).strict() },
"certificate-ocr": { maxCalls: 2, maxCostFen: 200,
  refs: z.object({ materials: materialRefs.length(1) }).strict(),  // 恰好 1 个图片材料版本
  conditions: z.object({ certificateKind: z.string().trim().min(1).max(64), externalProcessingConsent: z.literal(true) }).strict() },
"bid-verification": { maxCalls: 0, maxCostFen: 0,                  // 确定性比较，无外部请求
  refs: z.object({
    materials: materialRefs,
    requirementSet: z.object({ id: identifier, versionId: identifier, sha256 }).strict(),
    externalRecords: z.array(z.object({ recordId: identifier, sha256 }).strict()).max(200).default([]),
  }).strict(),
  conditions: z.object({ asOf: day }).strict() },
```

- 删除既有 `bid-verification` 旧定义；浏览器仍只提交 `kind/projectId/refs/conditions`；旧形状（仅 materials + 可选 asOf）必须被拒绝（回归测试）。
- `certificateKind` 用受控字符串：目录不把未实测种类写成能力；提交时由 `src/server/tasks/admission.ts` 的 kind 准入钩子按 `OcrAdapter.supportedKinds()` 拒绝（不写库、返回 503/422），执行前再校验一次；默认不可用适配器支持清单为空。
- `requirementSet` 无 `projectId` 键，既有 `assertProjectScope` 不覆盖它；执行器必须用项目作用域读取结果并核对所属项目、版本与摘要（跨项目统一失败，不写成果）。
- `externalRecords` 是服务端输入清单的一部分：浏览器显式选择记录（记录 id + 摘要），执行器只读取这些记录并重新校验归属、要求集版本与摘要；记录之后追加不会静默改变已提交任务或旧成果。
- 更新 `src/server/tasks/catalog.test.ts` 与 `src/server/tasks/test-fixtures.ts`。

### 4.4 任务准入钩子（`src/server/tasks/admission.ts` + `tasks/service.ts` 最小改动，Lead 写）

```ts
export type TaskAdmission = (input: { kind: TaskKind; projectId: string; refs: Record<string, unknown>; conditions: Record<string, unknown> }) => Promise<void>
export function registerTaskAdmission(kind: TaskKind, admission: TaskAdmission): void
export function taskAdmission(kind: TaskKind): TaskAdmission | null
```

- `submitTask` 在鉴权、解析、构建 manifest 之后、入库之前调用已注册准入钩子；钩子拒绝时抛 `TaskError`（503 `SERVICE_UNAVAILABLE` / 422 `INVALID_SUBMISSION`）或 `BusinessError("SERVICE_UNAVAILABLE"/"INVALID_INPUT")`，均不入库。
- A 的 OCR 运行时注册 `certificate-ocr` 准入：适配器不可用 → SERVICE_UNAVAILABLE；`certificateKind` 不在 `supportedKinds()` → INVALID_SUBMISSION。

### 4.5 迁移 0010 表结构（Lead 写 `src/server/verification/schema.ts`）

只用 `CREATE TABLE`/`CREATE INDEX`；不新增 CHECK、部分索引、CTE 或 RETURNING（spec/04 双 provider 边界）；列类型/长度全部写定，枚举与状态转换由服务端校验并断言条件更新恰好影响一行。字段表采用**插入式历史**（同一材料版本可多次 OCR、可人工更正、可含多个材料主体），不做原地覆盖，不用 `UNIQUE(project_id,version_id,field)`。

- `equilens_ocr_runs(id VARCHAR(36) PK, project_id VARCHAR(36), material_id VARCHAR(36), version_id VARCHAR(36), certificate_kind VARCHAR(64), state VARCHAR(16), provider VARCHAR(64), provider_version VARCHAR(64), request_id VARCHAR(128), calls_used INTEGER, usage_json TEXT, image_json TEXT, error_code VARCHAR(64), created_by VARCHAR(36), started_at VARCHAR(32), finished_at VARCHAR(32))` + 索引 `(project_id, material_id)`、`(state)`；`state ∈ running|succeeded|partial|failed|unavailable`。
- `equilens_verification_fields(id VARCHAR(36) PK, project_id VARCHAR(36), material_id VARCHAR(36), version_id VARCHAR(36), subject_key VARCHAR(64), field_key VARCHAR(64), label VARCHAR(128), value_text TEXT, normalized_value TEXT, origin VARCHAR(16), source_snapshot_id VARCHAR(36), source_fragment_id VARCHAR(64), ocr_run_id VARCHAR(36), confidence INTEGER, box_json TEXT, revision INTEGER, previous_id VARCHAR(36), superseded_at VARCHAR(32), created_by VARCHAR(36), created_at VARCHAR(32), reason VARCHAR(500))` + 索引 `(project_id, version_id, field_key)`；`origin ∈ ocr|manual|material_text`；当前值 = `superseded_at IS NULL`，同一 `(project_id,version_id,subject_key,field_key)` 至多一条当前值；更正先插入新行（`previous_id`、`revision+1`）再条件更新旧行 `superseded_at`，影响行数必须为 1。`confidence` 为 0—100 整数。
- `equilens_verification_records(id VARCHAR(36) PK, project_id VARCHAR(36), requirement_set_version_id VARCHAR(36), requirement_id VARCHAR(64), subject VARCHAR(200), certificate_no VARCHAR(128), source VARCHAR(500), queried_at VARCHAR(32), query_conditions_json TEXT, conclusion VARCHAR(16), proof_material_version_id VARCHAR(36), sha256 VARCHAR(64), created_by VARCHAR(36), created_at VARCHAR(32))` + 索引 `(project_id, requirement_set_version_id)`；`conclusion ∈ matched|conflict|not_found|query_failed|pending`；追加式，无更新/删除路由。
- `migrations.ts` 追加 `{ id: "0010", statements: verificationStatements }`；`migrations.test.ts` 增 0010 摘要、空库应用、重复启动、回滚与 0001—0009 摘要不变断言。任何持久开发库在 0010 应用前以重建为准，禁止改已应用 0010。

### 4.6 共享字段读取接缝（`src/server/verification/field-source.ts`，Lead 写）

```ts
export type VerificationFieldValue = {
  materialId: string; versionId: string; subjectKey: string
  fieldKey: VerificationFieldKey; label: string
  valueText: string; normalizedValue: string
  origin: "ocr" | "manual" | "material_text"
  sourceSnapshotId: string | null; sourceFragmentId: string | null; ocrRunId: string | null
  confidence: number | null; revision: number; updatedAt: string
}
export type FieldSource = { values(projectId: string, materialVersionIds: readonly string[]): Promise<VerificationFieldValue[]> }
```

`values` 只返回当前值（`superseded_at IS NULL`），按 `(subjectKey, fieldKey)` 排序；A 实现，B 只消费。跨包集成测试：A 的仓储写入 → B 的 compare 读取并得到预期材料检查状态。

### 4.7 成果、校验器与导出（Lead 集成时接线，Agent B 先交付模块）

- `bid-requirements`：登记进 `src/server/results/access.ts` 的 machine-only 集合；普通浏览器成果 POST 不能写入。人工确认/更正通过**服务端受控保存**：`VerificationService.saveRequirementSet` 重读每条要求的 `snapshotId/fragmentId/quote`（同项目、同材料版本、`quotesMatch` 逐字校验、材料活动状态），组装 `sources` 并调用新增的 `ResultService.saveResultRevision(identity, authorize, input, undefined, { serverOwned: true })` 写入人工版本；新 operationId 幂等、旧基础版本 409。HTTP：`POST /api/projects/[id]/verifications/requirements`。
- `ResultService` 增补（Lead）：构造函数第 4 参 `serverOwnedKinds`；`saveResultRevision(..., options?: { serverOwned?: boolean })` 仅在 `machineOnlyKinds.has(kind) && options.serverOwned && serverOwnedKinds.has(kind)` 时允许非 machine 写入；`serverOwned` 不进入 HTTP 允许键（`results/http.ts` 白名单不含它，加测试）。`results/access.ts`：machine-only = `contract-review`、`bid-requirements`、`bid-verification`；server-owned = `bid-requirements`。
- `bid-verification`：机器基线，只由任务执行器写入；重跑产生**新成果（新 resultId）**，旧成果保持可读、可复核、可导出（不修改 A4 服务写版本语义）。
- 结果 value（B 定义，spec §8.2.3 冻结）必须内嵌：`schemaVersion:1`、`status`、`asOf`、`requirementSet{id,versionId,sha256,requirements:[{requirementId,quote,source{snapshotId,fragmentId},nature,...}]}`、`materials:[{materialId,versionId,sha256}]`、`records:[{recordId,sha256,subject,certificateNo,source,queriedAt,queryConditions,conclusion,proofMaterialVersionId}]`、`items:[{requirementId, materialCheck, externalCheck, detail, evidence:[{fieldKey,valueText,origin,subjectKey}]}]`、`coverage`、`unfinished`、`warnings`、`errors`。导出模板只读该 value。
- 校验器 `bidRequirementSetValidator`：结构、词表内字段、已知性质/运算符、来源字段结构完整、无自动否决；逐字来源由 `saveRequirementSet` 复核与 `ResultService` 的 `sources` 检查共同保证，校验器本身不访问数据库；候选阶段未定项 → partial（可保存、不可比较），确认齐全 → valid。
- 校验器 `bidVerificationResultValidator`：结构；要求集/材料/记录快照一致性；两组状态独立；`未核验/未查到/查询失败/pending` 永不映射为通过；记录字段完整且 `matched` 的主体/证号必须与比较证据一致；未完成/待确认 → partial；结构/引用/记录完整性违规 → invalid；invalid 可由机器保存用于审计但任务终态 failed 且禁止导出；approve 仅对 valid。
- 导出模板 `bid-verification-report-v1`：两组状态列、逐条要求原文与来源、外部核验记录元数据、未完成清单、AI 标识；`blocksInvalidResult: true`，partial 以草稿导出；旧导出字节不变。`bid-requirements` 无导出模板（导出 503）。
- 导出保留期（Lead，`src/server/exports/access.ts`）：除 sources 外，读取所导出成果版本的 `dependencies` 中 `kind="material"` 的材料保留期并取最早；核验成果依赖含要求集结果版本与各比较材料版本；任一依赖无法解析 → 拒绝生成。
- 外部核验记录（B）：追加式；`requirementId` 必须存在于所选要求集版本；`matched` 需主体/证号与比较证据一致；多条冲突 → 记录冲突；缺失 → 未核验；`pending` → 待人工核验；证明必须是本项目活动材料版本且在保留期内；写入后旧成果显示“记录/字段已更新，需重新运行”提示（比较当前状态与内嵌摘要）。
- 依赖变化：核验成果依赖记录 `kind:"result"`（要求集版本）与 `kind:"material"`（比较材料版本），供 A4 依赖提示使用。

### 4.8 OCR 边界（冻结）

- `src/server/verification/ocr.ts`：`type OcrAdapter = { available(): boolean; supportedKinds(): readonly string[]; recognize(request: OcrRequest): Promise<OcrExtraction> }`；`createOcrAdapter(env)` 在缺少已验证 endpoint/凭据/区域/实测种类清单时返回 `createUnavailableOcrAdapter(reason)`；`syntheticOcrAdapter` 只存在于 `ocr-test-fixtures.ts`，并由测试断言生产模块不导入该文件。
- 生产不得导入合成替身；`available() === false` 时：证照图片在材料写入路径拒绝（`QueuedMaterialService` 使用统一产品文案）、`certificate-ocr` 执行器不注册且准入钩子拒绝（`POST /api/tasks` 503、不入库）、界面（第五轮）不显示提交入口。
- 每个 OCR 任务最多 2 次请求（`certificate-ocr` maxCalls 2），由持久调用计数约束；显式新任务重新计次并在界面提示；调用前预留预算，恢复不重置。
- 人工路径：文本格式资质材料允许人工登记字段，但必须绑定**同一材料版本**的、经 `quotesMatch` 逐字匹配的 `source_fragment_id` 才计为材料支持；否则状态为待确认。人工录入不得显示为 OCR 结果或官方实时查询；字段保留原值与归一化值。
- 图片材料不做 `material-parse`、不声称可编辑、不产生“已提取全文”；上传意图在图片登记完成后进入终态（可空解析任务），修复扫描不得为图片重投解析。

### 4.9 HTTP 契约（C4）

- 复用：`POST/GET /api/tasks`（三类任务）、`/api/projects/[id]/results[/…]`（核验结果读取/校验/复核）、`/api/projects/[id]/results/[resultId]/exports`（核验结果导出）。
- 新增：`GET /api/projects/[id]/verifications`（只列 `bid-requirements`/`bid-verification`，其他 kind 统一 404）、`GET /api/projects/[id]/verifications/[resultId]`（结果 + 外部记录 + 字段/记录已更新提示）、`POST /api/projects/[id]/verifications/requirements`（服务端复核保存要求集）、`POST /api/projects/[id]/verifications/[resultId]/external-records`（人工核验记录追加）、`GET/POST /api/projects/[id]/materials/[materialId]/versions/[versionId]/fields`（字段读取与人工登记/更正）。
- 所有新入口：Node runtime、`dynamic="force-dynamic"`、`Cache-Control: private, no-store`、写请求同源 Origin、逐次重验项目权限；只读成员只读；跨项目/未知资源统一 404；错误复用 `src/server/projects/errors.ts` 的安全映射，不泄漏 SQL/材料正文。

## 5. 工作包

### C4-OCR（Agent A）

**目标：** 诚实失败/关闭的证照 OCR 通路；图片材料只在 OCR 适配器可用时受理，且不重投解析；OCR 运行与字段可审计（插入式历史）、可人工更正；文本材料字段可人工登记并按同版本原文逐字核对。

- [ ] `ocr.ts` + `ocr-runtime.ts`：适配器工厂（默认不可用、测试注入）、`supportedKinds()`、单次请求超时/失败与用量；注册 `certificate-ocr` 执行器与准入钩子（显式 Node 生命周期，导入不启动）。
- [ ] `ocr-repository.ts`：实现 §4.6 `FieldSource` 读取，并提供 OCR 运行写入/查询、字段插入式写入/更正（OCR 运行写入与人工更正同样先插入新行（`previous_id`、`revision+1`）再条件更新旧行 `superseded_at`，同一事务内断言影响行数 1，保证并发下至多一条当前值）与当前值查询；原值/归一化值/更正/来源/置信信息分列；按项目授权。
- [ ] `ocr-executor.ts`：`certificate-ocr` 执行器——恰好 1 个图片版本、归属/摘要/保留期复核、每任务 ≤2 次调用、调用前预算预留、运行与字段写入、失败如实返回错误码、不写演示结果；未注册时提交 503。
- [ ] 材料图片门控：`materials/{service,queued,repository,types,validation,parse,executor,runtime,upload-intents,http-runtime,http}.ts`——仅在 `ocr.available()` 时受理 PNG/JPEG；4 MiB、8192 px 边长、40 MP；类型伪装拒绝；图片不进入 `material-parse`、不可编辑；图片登记的上传意图以“无解析任务”终态提交，修复扫描/重复上传路径不得为图片重投 `material-parse`；解析执行器对 image 防御性拒绝；`MaterialFormat` 增加 `image` 后修正所有受影响类型（含 `reviews/input.ts` 最小过滤、`materials-client.ts` 宽化）；A4c 合同审查回归测试保持通过。
- [ ] 字段接口：`GET/POST .../versions/[versionId]/fields`（读取原值/归一化值/更正历史/来源；写请求仅管理员/可编辑成员；人工登记必须引用同版本、逐字匹配的项目片段，或标记待确认；同操作幂等；查看者 403；跨项目 404）。
- [ ] 测试：`ocr.test.ts`、`ocr-repository.test.ts`、`ocr-executor.test.ts` 与 materials 增量；覆盖不可用 403/422/503、模糊关键字段、第三次调用拒绝、预算失败 0 次外部调用、撤权/保留期/旧令牌不调用外部、跨项目拒绝、失败无假结果、图片限制全边界、上传意图修复不重投解析、生产不导入合成替身、同版本/跨版本片段、多主体字段。
- **不宣称：** 任何证照种类已支持、OCR 置信度证明真实性、无 OCR 时“已识别全文”。

### C4-VERIFY（Agent B）

**目标：** 投标材料核验服务端闭环：要求候选（模型注入）→ 服务端复核保存的要求集（人工确认）→ 材料字段对照（确定性）→ 两组状态 → 版本化成果与导出；外部核验记录追加式有据可查；无外部服务也可完成服务端闭环验收。

- [ ] `types.ts` + `src/lib/business/verification-types.ts`：§4.7 结果 value、两组状态、要求条目（含 `field` 为共享词表键、`operator`、`asOf` 语义、补遗状态、单层 AND/OR）；不新增事实表、不使用浮点金额；要求集 value 需与源模块共用词表/归一化。
- [ ] `requirements.ts`：候选规范化、`bidRequirementSetValidator`（词表内字段、已知性质/运算符、逐字来源、无自动否决、候选 partial/确认 valid）、`assertReadyForComparison`（拒绝未确认/性质待确认/摘要不符）。
- [ ] `compare.ts`：纯函数确定性比较；支持 eq/neq/in/not_in/≤/≥/on_or_before/on_or_after/contains 与单层 AND/OR；字段缺失→材料缺失；值不符→字段冲突；日期不满足；无法表达/嵌套→待人工判断；补遗冲突→待确认；无证据→待确认；未核验外部真实性绝不输出通过；输入相同则输出规范一致（无时钟/随机/浮点）。
- [ ] `input.ts`：按任务 manifest 重新读取材料版本/快照/片段、要求集版本与**固定外部记录清单**，复核归属、摘要、活动状态、保留期与记录摘要；未知/跨项目/已删记录拒绝。
- [ ] `executor.ts` + `extractor.ts`：`bid-requirements`（模型只提候选、逐字来源映射、失败不保存演示要求）与 `bid-verification`（确定性比较、写入内嵌快照的机器成果；invalid 结果也保存用于审计但任务 failed，禁止导出）；每阶段 `refreshAccess`、`asOf` 必填；`requirementSet` 项目作用域核对；重跑创建新 resultId。
- [ ] `records-repository.ts` + `validation.ts` + `service.ts`：外部核验记录追加与校验（§4.7 语义）；`saveRequirementSet` 服务端复核保存（逐字片段、同版本、`quotesMatch`、组装 sources、调用 serverOwned 保存）；列表/详情含“记录/字段已更新”提示；只读成员只读。
- [ ] `service.ts`/`http.ts`/`access.ts`/`runtime.ts`：§4.9 契约；显式生命周期注册两个执行器；跨项目统一 404；kind 过滤。
- [ ] `export-template.ts`：`bid-verification-report-v1` 正文（Lead 登记）；不调用模型、不动旧文件，partial 保留草稿标记。
- [ ] 测试：`requirements.test.ts`、`compare.test.ts`、`validation.test.ts`（valid/partial/invalid × 复核/导出矩阵、两组状态、记录映射逐项）、`executor.test.ts`（撤权、保留期、预算、旧令牌、摘要不符、记录 pin、重跑新 resultId、invalid 保存但失败）、`service.test.ts`（要求集伪造/失配/跨项目片段拒绝、记录追加/冲突/证明校验、旧成果不受新记录影响）、`http.test.ts`（401/403/404/只读/no-store/kind 过滤）、`field-integration.test.ts`（A 仓储 → compare）。
- [ ] 无外部服务服务端闭环测试（不依赖真实 OCR/MaaS/OBS）：合成项目 → 服务端保存要求集（假提取器/固定值）→ 文本材料人工字段 → 提交 `bid-verification` 任务 → 轮询成功 → 校验 → 复核批准 → 导出 → 下载校验 sha256；反例：缺材料 → partial/无效 → 导出被阻断。
- **不宣称：** AC-04/AC-08/AC-22 整项通过（领域标注与真实 OCR 未完成）、6 个封存案例已实跑、外部实时官方查询。

## 6. 合入顺序、门禁、验收与证据

1. W0：分支、规格、词表/归一化、catalog、admission、契约类型、schema/0010、field-source、ResultService/access、exports/access 接缝、tests/fixtures；`pnpm check` 基线通过后开工。
2. 合入顺序：C4-OCR → C4-VERIFY（B 依赖 A 的 `FieldSource` 实现与字段接口；接口已在 W0 冻结，A 先交付 `ocr-repository.ts` 并通知）。每包完成后 Lead 按路径隔离提交，跑定向检查。
3. 集成：Lead 接线 `results/registry.ts`、`results/access.ts`、`exports/template.ts`、`instrumentation.ts`、`package.json` 测试路径、`migrations.ts`/`migrations.test.ts`（0010）。
4. 评审：先由独立 reviewer 审查本计划（已完成并修订）；每包完成后由另一 Agent 交叉审查接口与测试，Lead 主审并修复；缺陷修复独立提交。
5. 门禁：`pnpm check`、`pnpm test`、`pnpm build`、`pnpm smoke http://127.0.0.1:3000`、`git diff --check` 全部 exit 0；测试数如实记录；不并发重跑同一 `.next`；测试路径加入默认 `pnpm test`。
6. 验收（本轮必须实际执行）：**无外部服务的服务端闭环**——启动本地 dev 服务（端口 3000，精确 `http://127.0.0.1:3000`）与本地 SQLite/开发对象存储，用合成项目完成：字段登记 → 要求集服务端保存 → `bid-verification` 任务 → 轮询成功 → 校验/复核/导出/下载（记录字节摘要）；反例：缺材料 → partial/无效 → 导出阻断；OCR 不可用时图片上传拒绝与 `certificate-ocr` 提交 503。真实模型/OCR 调用只在配置可用时各发起一次并记录用量，不可用保留外部缺项。
7. 证据：`docs/reviews/2026-10-29-round-four-c4-ocr.md`、`2026-10-29-round-four-c4-verify.md`、`2026-10-29-round-four-integration.md`；记录实际命令/退出码/测试数/样本/失败修复/未运行项；不推送、不部署、不建 Issue。
8. 配置：`.env.example`/README 记录 OCR 适配器配置名与“未验证即 fail-closed”的边界（不含真实密钥）。

## 7. 不宣称与外部缺项

- 真实 OCR 账号/种类/价格未验证：生产 OCR fail-closed，图片材料默认拒绝；AC-02 OCR 条款与 AC-04 证照图片路径保持未通过。
- 领域要求标注与规则未签核：校验器只保证结构/来源/状态一致；AC-04 业务正确性、AC-08/AC-22 整项与 6 例封存案例不做通过声明。
- 无权威外部查询 API：仅人工核验记录，明确标注人工来源；AC-14 的证明附件恢复依赖 C7。
- 无真实 GaussDB：0010 仅 SQLite 验证；provider 语法、索引与并发行为保持未验证。
- 真实 OBS/MaaS 外部能力、公网 HTTPS、CI 运行、Docker/Linux：保持外部缺项，不以合成存储或本地命令替代。
- C6 P1、C5、C7、A5 不在本轮范围，分别由后续轮次规划与验收。

## 8. 后续轮次（暂定，下一轮开始时重新规划与审查）

- **第五轮：** C4-UI（业务选择器 + 核验工作区 + client + 浏览器验收）、C6（发布仓储与 0011、`TaskManifest.publications`、私有维护 CLI、发布版本固定与停用隔离；规范库 P1 保留空状态并登记未交付）、C5（模板仓储/起草输入、专业分包合同与补充协议的确定性填充、成果/导出接线、C5 UI）。三者写作用域互斥，业务宿主文件由 Lead 在 W0 重写并接线。
- **第六轮：** C7（生命周期、对象回收、删除记录重放、完整恢复脚本与演练）+ A5（SQLite 备份恢复、卷式重启、5 用户并发/队列容量、smoke、CI/部署事实登记与缺项、全量门禁与证据汇总）。
- **第七轮（如需要）：** A/C 全量验收证据、AC 对照表、未通过项与外部缺项汇总；全部工作包完成即停止。

## 9. 每包完成定义（DoD）

- 行为测试先写：金额/权限/版本/状态/失败路径正常与反例；不写只镜像实现的无意义测试。
- 实现接入真实持久化、授权守卫与任务执行器；不新增独立服务、队列或开放 Agent 平台。
- 定向测试 + 受影响回归通过；提交独立、消息简短；证据记录实际命令、样本、失败与未运行项。
- 交指定审查人：C4 两包由 Lead 主审并交叉核对；发现缺陷修复后独立提交。
- 只有实际执行的检查可写通过；外部门槛保持缺项。
