# 第四轮 C4-OCR 包实施证据（2026-10-29）

> 工作包：R4-C4-OCR（Agent A）。分支 `alaaladaka/round4/verification`，基线 HEAD `c9ac2bb`（W0 冻结已提交）。
> 本文件只记录实际执行的命令、退出码和结果；未执行项单列。本轮**未**执行 `git add` / `git commit` / 推送 / 部署（由 Lead 负责提交）。

## 1. 交付范围

写作用域内的改动（`git status`）：

新增：

- `src/server/verification/ocr.ts` — `OcrAdapter` 边界、`createOcrAdapter`（fail-closed）、`createUnavailableOcrAdapter`、`OcrError`。
- `src/server/verification/ocr-test-fixtures.ts` — **仅测试用**合成适配器与 PNG/JPEG 夹具；生产模块不导入（有测试断言）。
- `src/server/verification/ocr-runtime.ts` — 显式 Node 生命周期 `startOcrRuntime()`（Lead 在 `instrumentation.ts` 接线，需先于 `startTaskRunner`）。
- `src/server/verification/ocr-repository.ts` — 实现冻结 `FieldSource`（`values(projectId, materialVersionIds)`，只读当前值）；OCR 运行插入/条件终态；字段插入式历史/更正（`previous_id`/`revision+1`/`superseded_at`，同一事务内断言“恰好一条当前值”）；`completeRun` 把字段与运行终态放在同一事务；`VerificationFieldService` 人工字段路径（同版本片段 `quotesMatch` 逐字核对，否则待确认）。
- `src/server/verification/ocr-executor.ts` — `certificate-ocr` 执行器（恰好 1 个图片版本；逐次重验归属/摘要/活动状态/保留期/授权；最多 2 次付费请求且每次 `reserveCall` 先于请求；如实运行状态；失败零假结果）；`certificateOcrAdmission` 与 `registerCertificateOcrCapability`（准入钩子 503/422，未验证不注册执行器）。
- `src/app/api/projects/[id]/materials/[materialId]/versions/[versionId]/fields/route.ts` — `GET/POST` 字段路由（Node runtime、force-dynamic、私有 no-store、写请求同源、逐次重验权限）。
- 测试：`ocr.test.ts`、`ocr-runtime.test.ts`、`ocr-repository.test.ts`、`ocr-executor.test.ts`、`materials/image-materials.test.ts`。

修改：

- `src/server/materials/{types,parse,repository,queued,service,executor,runtime,upload-intents,http,http-runtime}.ts` — `MaterialFormat` 增加 `image`；PNG/JPEG 真实内容识别与 4 MiB / 8192 px / 40 MP 限制（统一一条产品文案）；仅 OCR 适配器可用时受理图片；图片不进入 `material-parse`（执行器防御性拒绝、reparse 拒绝）；上传意图对图片以“无解析任务”终态提交，修复扫描不重投 `material-parse`。
- `src/lib/business/materials-client.ts` — 仅最小宽化（`format: "image"`、上传返回 `parseTaskId: string | null`）。
- `src/server/reviews/input.ts` — 唯一一处最小图片过滤（合同审查遇到图片材料按 `INVALID_SOURCE` 失败，不改变既有审查行为）。
- 既有测试仅做依赖签名跟进：`materials.test.ts`、`queued.test.ts`、`executor.test.ts`（`ocrAvailable`/`fields` 注入）。

未改动冻结/共享文件：`spec/**`、`catalog.ts`、`admission.ts`、`service.ts`（tasks）、`verification/{schema,field-source}.ts`、`verification-fields.ts`、`contracts.ts`、`results/**`、`exports/**`、`instrumentation.ts`、`package.json`、迁移文件。

## 2. 实际执行的命令与结果

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `pnpm exec tsx --test src/server/materials/materials.test.ts src/server/materials/queued.test.ts src/server/materials/executor.test.ts src/server/materials/parse.test.ts src/server/materials/upload-intents.test.ts src/server/materials/image-materials.test.ts src/server/materials/lifecycle.test.ts src/server/materials/document-repository.test.ts src/server/materials/editor.test.ts src/server/materials/parser-process.test.ts src/server/verification/ocr.test.ts src/server/verification/ocr-runtime.test.ts src/server/verification/ocr-repository.test.ts src/server/verification/ocr-executor.test.ts` | 0 | `tests 92 / pass 92 / fail 0`（materials 54 + C4-OCR 38；materials 内含新增 `image-materials.test.ts` 8 项） |
| 2 | `pnpm exec tsx --test src/server/reviews/*.test.ts` | 0 | `tests 34 / pass 34 / fail 0`（`reviews/input.ts` 最小过滤回归） |
| 3 | `git diff --check` | 0 | 无空白错误 |
| 4 | `pnpm exec eslint`（本包改动文件，含新增 `ocr*.ts`、`image-materials.test.ts`、fields 路由、materials-client、reviews/input） | 0 | 无 error / 无 warning（`--max-warnings 0` 口径下本包文件通过） |
| 5 | `pnpm exec tsc --noEmit` | 0 | 全工作树通过（交叉审查修复后复跑；期间 C4-VERIFY 进行中文件的类型错误由其修复，本包文件始终无错误，见 §3） |

测试计数说明：新增 C4-OCR 行为测试共 38 项（`ocr.test.ts` 7、`ocr-runtime.test.ts` 3、`ocr-repository.test.ts` 10、`ocr-executor.test.ts` 18），图片材料/字段 HTTP 共 8 项（`image-materials.test.ts`，含 multipart HTTP 写入路径的图片门控/限制/无解析任务断言）。

## 3. 类型检查（`pnpm exec tsc --noEmit`）

- 最终复跑退出码 **0**（全工作树通过，交叉审查修复完成后复跑）。
- 过程中出现的类型错误均位于 **C4-VERIFY（Agent B）进行中文件**，不在 C4-OCR 写作用域：首轮为其 `executor.ts`/`service.ts` 的进行中改动；交叉审查修复轮为其 compare/validation/export-template 的 `subject`/`confidence` 结构迁移。B 完成后均复跑通过。C4-OCR 本包文件（materials/**、verification/ocr*、fields 路由、materials-client、reviews/input）在全部过程中无类型错误。

## 4. 关键行为与测试映射

| 契约要求 | 实现 | 测试 |
| --- | --- | --- |
| 默认 OCR fail-closed，未验证即拒绝；合成替身只在测试 | `ocr.ts` / `ocr-test-fixtures.ts` | `ocr.test.ts`（不可用 503/异常、配置齐全仍关闭、生产模块 import 扫描） |
| `certificate-ocr` 准入：未验证 → 503、未实测种类 → 422，均不入库 | `certificateOcrAdmission`/`registerCertificateOcrCapability` | `ocr-runtime.test.ts` |
| 执行器恰好 1 个图片版本；归属/摘要/保留期/授权复核；每次调用前 `reserveCall` | `ocr-executor.ts` | `ocr-executor.test.ts`（摘要不符、跨项目、非图片、保留期过期、撤权、租约丢失、预算失败 0 次外部调用） |
| 每任务最多 2 次 OCR；恢复不重置；第三次拒绝；单次请求超时 | `ocr-executor.ts`（`requestTimeoutMs` + `AbortSignal`，`job.callsUsed`/`job.maxCalls`） | `ocr-executor.test.ts`（`callsUsed=2` 零调用；连续失败恰好 2 次；挂起请求超时后如实失败） |
| 失败/部分如实：运行状态 running→terminal、失败不写字段 | `OcrRepository.beginRun/finishRun/completeRun` | `ocr-repository.test.ts`、`ocr-executor.test.ts` |
| 字段插入式历史、更正 `previous_id/revision+1/superseded_at`、恰好一条当前值（事务内断言） | `OcrRepository.insertFields` | `ocr-repository.test.ts`（更正历史、幂等重试、并发写后仍 1 条当前值、多主体） |
| `FieldSource` 只返回当前值并按 `(subjectKey, fieldKey)` 排序 | `OcrRepository.values` | `ocr-repository.test.ts` |
| 文本材料人工字段必须引用同版本、`quotesMatch` 逐字匹配片段，否则待确认 | `VerificationFieldService` | `ocr-repository.test.ts`、`image-materials.test.ts`（HTTP 400 失配/伪造；pending=待确认） |
| 人工字段写入前重验项目 edit 权限、材料 active + processing_authorized、项目/材料保留期（交叉审查修复 #1） | `VerificationFieldService.revalidateWrite` | `ocr-repository.test.ts`（保留期过期/未授权处理/材料删除/中途撤权均不产生字段行） |
| OCR 字段写入前重验（提供方调用之后、INSERT 之前；交叉审查修复 #1） | `ocr-executor.ts` 的 `revalidate()` 于 `completeRun` 前再次执行 | `ocr-executor.test.ts`（调用后保留期到期/撤权 → 0 字段写入，错误码如实） |
| 证照种类标识符与中文名归一化到同一主体组；未实测/未知种类在 OCR 前拒绝；已实测但无显式主体映射的种类 fail-closed（交叉审查修复 #2 + 二次加固） | `subjectKeyFor` 返回 `"enterprise" \| "person" \| null`；`certificateOcrAdmission` 做 allowlist，执行器再做显式映射校验 | `ocr-executor.test.ts`（`营业执照`/`enterprise_license` 同为企业组，人员组同理；无映射 kind → `null`；adapter allowlist 含但未映射的种类在 0 次提供方调用前返回 `OCR_KIND_NOT_SUPPORTED`） |
| OCR 置信度逐字段持久化，低置信字段原样保留供后续待确认（交叉审查修复 #3） | `OcrRepository` 字段行 `confidence` 列 | `ocr-repository.test.ts`（42/null 持久化并在更正后历史保留）、`ocr-executor.test.ts`（低置信 40 原样传入字段写入） |
| 图片仅在 OCR 可用时受理；PNG/JPEG 真实内容；4 MiB/8192 px/40 MP 一条文案 | `parse.ts`/`queued.ts`/`http-runtime.ts` | `ocr.test.ts`、`image-materials.test.ts`（全边界 + 伪装类型） |
| 图片不进入 `material-parse`；上传意图终态无解析任务，修复不重投 | `queued.ts`、`upload-intents.ts`、`runtime.ts`、`service.ts`、`executor.ts` | `image-materials.test.ts`（首次/重复上传零解析任务、崩溃窗口意图修复无解析任务、`material-parse` 执行器拒绝图片） |
| 字段 HTTP：私有 no-store、同源写、读权限、写 edit、跨项目/未知 404、幂等 | `materials/http.ts` + 路由 | `image-materials.test.ts`（401/403/404/no-store/同源/viewer 只读/同 operationId 幂等） |

## 5. 未执行项 / 外部缺项（不得声称通过）

- 未运行 `pnpm check` / `pnpm test` / `pnpm build` / `pnpm dev` / `pnpm smoke`（按任务约束，由 Lead 在集成阶段执行）。
- 未做浏览器 / dev 服务端到端验收（Lead 的 I1 集成）。
- 已由 Lead 接线（本次仅复核文件文本，未执行这些门禁）：`src/instrumentation.ts` 在 `startReviewRuntime()` 之后、`startTaskRunner()` 之前调用 `startOcrRuntime()`；`package.json` 的 `pnpm test` 已加入 `src/server/verification/*.test.ts`；`.env.example` 已登记 `OCR_ENDPOINT`/`OCR_ACCESS_KEY_ID`/`OCR_ACCESS_KEY_SECRET`/`OCR_REGION`/`OCR_SUPPORTED_KINDS`（示例种类为标识符 `enterprise_license`）。
- **识别全文限制（不得声称 AC-02 通过）**：冻结的 0010 表结构没有“识别全文”列（`equilens_ocr_runs` 只有运行/用量/图片信息），本包 OCR 只能产生**字段级证据**（原值、归一化值、置信度、坐标、来源运行），不能保存或展示可查看的识别原文，也不能把“无可识别字段/无原文”表述为“已提取全文”。因此 spec §6.1 中“有原文可查看”的完整表述未实现，AC-02 OCR 条款不宣称通过。
- 无真实 OCR 账号/实测证照种类/价格配额：生产适配器即使配置齐全也保持不可用（`createOcrAdapter` 返回 unavailable），`certificate-ocr` 不注册、图片材料默认拒绝；AC-02 OCR 条款与 AC-04 证照图片路径保持未通过。
- 未做真实 OBS/MaaS/GaussDB 验证；`0010` 仅 SQLite 验证。GaussDB 下字段“同一事务恰好一条当前值”的并发隔离行为未验证（SQLite 事务串行；schema 冻结无唯一部分索引）。
- 未运行 6 个封存投标案例（无领域标注数据），不声明 AC-04/AC-08/AC-22 整项通过。
- 未提交、未推送、未部署、未创建 Issue。

## 6. 已知风险与后续

1. **GaussDB 并发**：字段当前值唯一性依赖“先插入再条件更新 + 事务内计数断言”；GaussDB READ COMMITTED 下两个并发首插理论上可能各留一条当前值，需真实 GaussDB 验证后再宣称（schema 冻结，本轮未加唯一部分索引）。
2. **OCR 原文限制**：冻结的 0010 无“识别全文”列，`equilens_ocr_runs` 只保留运行元数据与图片信息；识别文本仅在适配器内存结果中用于判断“是否形成可用字段”，不落库、不展示、不冒充已提取全文。字段级证据（原值/归一化/置信度/坐标/运行 id）可用；AC-02 不宣称。后续若需“有原文可查看”，需在后续轮次以新迁移增加受控文本列并重新评审。
3. **主体标识**：OCR 单图 `subjectKey` 只接受显式映射：标识符（如 `enterprise_license`）与中文名（如 `营业执照`）通过别名归一化到同一组（企业 `enterprise` / 人员 `person`）；无显式映射的种类返回 `null`，执行器在任何提供方调用前以 `OCR_KIND_NOT_SUPPORTED` 受控失败（不默认企业组，避免把人员证照字段误标为企业主体而让混合主体 AND 要求看似满足）。新增实测种类须先补映射与测试。多主体只能通过人工字段显式 subjectKey 表达，界面轮次需展示。
4. **幂等实现**：字段写入使用从操作标识派生的确定性行 id（schema 无操作表），同一 operationId 重试不新增行；不同输入相同 operationId 由服务端拒绝或覆盖为下一历史版本（HTTP 层同操作同输入幂等）。
5. **上传意图终态**：图片意图以 `state='committed'` 且 `parse_task_id IS NULL` 表示无解析终态；`UploadIntents.open()` 通过材料版本 `content_type` 排除已提交的图片意图，`repair()` 另以 `isParseRequired` 防崩溃窗口重投。
6. **遗留人工路径**：`MaterialService.registerMaterial`（非 HTTP、当前生产未使用）仍拒绝图片；生产图片受理只经 `QueuedMaterialService`。

## 7. 交叉审查（task-9）修复记录

Lead 交叉审查结论 APPROVE WITH FIXES（复跑本包 87/87、reviews 34/34，无假通过/授权绕过），已按要求修复并复跑：

1. **人工字段/OCR 字段写入前重验**：`VerificationFieldService.register` 在 INSERT 前调用 `revalidateWrite`，重读项目 edit 权限、材料 `active` + `processing_authorized`、项目与材料保留期；`ocr-executor` 在提供方调用之后、`completeRun`（字段 INSERT + 运行终态同一事务）之前再次 `revalidate()`。失败为受控错误（`INVALID_SOURCE`/`NOT_FOUND`/`FORBIDDEN`），不产生字段行。新增 `ocr-repository.test.ts`（保留期过期、未授权处理、材料删除、中途撤权）与 `ocr-executor.test.ts`（调用后到期/撤权 → 0 字段）用例。
2. **证照种类归一化**：`subjectKeyFor` 将标识符（`enterprise_license` 等）与中文名（`营业执照` 等）归一到同一主体组，人员类同理；种类允许清单仍精确匹配 `OcrAdapter.supportedKinds()`，未实测/未知种类在 OCR 调用前拒绝。新增测试同时断言两种拼写产生同一 `subject_key`、未知种类 0 次调用。
   **二次加固**：`subjectKeyFor` 现返回 `"enterprise" | "person" | null`，仅显式映射表命中才给出主体组；adapter allowlist 命中但无显式映射的种类（如未来新增 `unknown_person_kind`）在执行器阶段以 `OCR_KIND_NOT_SUPPORTED` 受控失败，且在任何提供方调用前返回（0 次调用、无 OCR 运行行、无字段），不再默认归入企业组。新增 `ocr-executor.test.ts` 用例：adapter available + `supportedKinds: ["unknown_person_kind"]` + 准入通过 → 执行器失败、0 次调用。
3. **置信度持久化**：字段行的 `confidence` 原值持久化（低置信/部分字段不被丢弃），更正后历史行仍保留原置信度；新增 `ocr-repository.test.ts`（42/null 持久化 + 历史保留）与 `ocr-executor.test.ts`（低置信 40 原样传入写入）断言。比较侧的 待确认 规则由 C4-VERIFY 负责。
4. **证据更新**：测试计数与命令按修复后复跑结果更新；识别全文限制已按“冻结 0010 无全文列、仅字段级证据、AC-02 不宣称”如实记录（§5/§6.2）。
