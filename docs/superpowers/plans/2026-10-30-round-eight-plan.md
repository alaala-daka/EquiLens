# EquiLens 第八轮实施计划（B 线第二段：项目证据整理与项目催款函）

> 执行说明：本文件是第七轮 B 线第一段（事实/款项/审查处理决定）之后的第二段计划，沿用总计划工作包编号 B4/B5。
> 不新增未经审查的产品契约；本文件是实施计划，不是完成记录；不自动创建 Issue、推送、部署或发布。
> 基线：`alaaladaka/round7/mainline` @ `cafa9f8`（第七轮已收口，门禁与浏览器验收见 `docs/reviews/2026-10-30-round-seven-integration.md`）。
>
> 本轮目标：把 B 线剩下的两条业务从「领域层/匿名增量」推进为**正式项目主线**，并完成四业务主线端到端演练与 B 线验收：
> 1. **B4** 项目证据整理：不可变证据项版本 → 服务端确定性组装证据报告（时间线/争点/证据对应/缺证项）→ `evidence-report` 项目成果 → 重验/复核/Word+Markdown 导出；
> 2. **B5** 项目催款函：显式选择事实/款项/证据保存版本 + 人工填写发函与送达计划 → 固定模板 `collection-letter-v1` 确定性渲染 → `collection-letter` 项目成果 → 重验/复核/DOCX 导出（不自动外发）；
> 3. **E2E** 四业务主线端到端（合同审查 → 款项核对 → 证据整理 → 催款函）新输入演练 + B 线验收记录与 AC 对照。
>
> 本轮不宣称法律准确率、不宣称真实云平台验收；外部缺项如实保留（§7）。

## 1. 范围与既有边界

**已存在、本轮复用但不改契约的资产**

- 匿名文档 Agent 增量（`/api/contract-reviews/[id]/{letter,revision}`、`document-agent/letter.ts`、`document-agent` 证据投影）：**保持现状**，不迁移、不改写其契约。项目主线与其各自独立，不共享成果、不互相冒充。
- `src/server/evidence/**` 领域层（`EvidenceRepository`、`composeEvidenceReport`、`evidenceReportMarkdown`、`validateEvidenceItem/ReportInput`、scope 校验）：本轮作为项目主线的实现基础，**必须扩展为迁移账本 + 幂等 + 项目服务**，不重写语义。
- 项目成果基础设施（`results` 表、校验器注册表、复核、导出模板、删除/恢复清单）：`evidence-report` 与 `collection-letter` 都走这套，不另建第二套版本/复核机制。

**明确不在本轮**

- 不开放 `evidence-organization` / `collection-letter` 的模型任务执行器（两者继续保持 503）：本轮证据项与催款函均由人工录入 + 服务端确定性组装/渲染，不调用模型。
- 不做正文/章节富文本编辑、不做任意模板、不做自动外发/送达状态回写、不做诉讼材料。
- 不做真实 OBS/GaussDB/OCR/MaaS 定价验证、公网 HTTPS、Docker/Linux、GitHub CI、领域签核、24/60 独立业务质量集。

## 2. 规格增补（先改规格再实现，Lead）

**`spec/01-product.md`**

- §8.2.8「项目证据整理成果」（新增）：kind `evidence-report`；唯一写入路径为项目证据服务；value 固定 `{schemaVersion:1, cutoff, contractId?, items[], timeline[], disputes[], gaps[], suggestions[], scopeNotes[], status}`；`status` 由服务端按冲突/待核实/开放缺口/待关联派生（`incomplete` 或 `draft`），浏览器不得提交；证据项引用必须绑定本项目不可变证据项版本，事实链接必须是本项目事实版本，款项链接必须是本项目已保存款项成果版本；跨项目一律拒绝；`incomplete` → `partial`（可保存、可草稿导出、不可批准），`draft` → `valid`（仍须人工复核）；导出模板 `evidence-report-v1`（Word 正文与 Markdown 同结构），`blocksInvalidResult: true`。
- §8.2.9「项目催款函成果」（新增）：kind `collection-letter`；唯一写入路径为项目催款函服务；模板 `collection-letter-v1` 由代码版本化，只写合同依据、款项金额与来源、履行要求、拟发送安排，不自动添加利息/违约金/账户/法条/送达事实；输入必须显式选择：已确认事实版本（≥1）、`payment-reconciliation` 成果版本（`valid` 且 `calculation.unpaidFen > 0`）、可选 `evidence-report` 成果版本；服务端重新读取所选版本并固定快照；缺少必需字段或款项不可用 → `draft`（partial，不可批准），齐全 → `ready`（valid，可复核）；不自动外发；导出 `collection-letter-v1` Word。
- §9 更新开放任务类型说明：`evidence-organization`、`collection-letter` 继续无执行器 → 提交 503；项目主线使用成果服务而非模型任务。
- §4.5 补充一句：项目证据整理与项目催款函为正式项目主线入口，匿名文档 Agent 增量保持既有入口。

**`spec/02-workbench-ui.md`**

- §5.1／§5.2 业务选择增加「证据整理」「催款函」，并描述页签内区域与门槛：证据项编辑（来源、事实/款项链接、确认与支持状态、待关联）、时间线与争点、缺证项、报告生成/保存/重验/复核/导出；催款函选择事实/款项/证据版本、填写发函与送达计划、草稿与完整稿区分、复核后导出。
- §5.4／§5.5 补充：证据报告与催款函的保存冲突、无效引用、未完成项不得批准、导出门槛与普通成果一致。

**`spec/04-database-deployment.md`**

- 迁移 0015：`equilens_evidence_items` 纳入迁移账本（新增 `operation_id`/`request_hash`/`base_version_id`，项目内唯一幂等），仅追加 `CREATE TABLE`/`CREATE INDEX`；证据表从 `PROJECT_RUNTIME_TABLES` 移入必需项目删除与恢复清单；`0001—0014` 不改写。

**`src/lib/business/contracts.ts` / `src/lib/evidence/types.ts`**

- 冻结项目证据 DTO（`EvidenceItemDraft`、`EvidenceReportValue`、`SaveEvidenceReport`）与催款函 DTO（`CollectionLetterDraft`、`SaveCollectionLetter`），并注明服务端唯一写入路径与错误码。

## 3. 迁移 0015（Lead 注册并冻结 checksum）

```sql
CREATE TABLE equilens_evidence_items (
  id VARCHAR(36) PRIMARY KEY,
  item_id VARCHAR(36) NOT NULL,
  version_id VARCHAR(36) NOT NULL UNIQUE,
  project_id VARCHAR(64) NOT NULL,
  contract_id VARCHAR(64),
  base_version_id VARCHAR(36),
  operation_id VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  supersedes_version_id VARCHAR(36),
  sha256 VARCHAR(64) NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, operation_id)
);
CREATE INDEX equilens_evidence_item_project ON equilens_evidence_items(project_id, item_id, created_at);
```

- 证据报告走 `equilens_results`（kind `evidence-report`），不再写入 `equilens_evidence_reports`；旧表不再由新代码创建或写入，历史开发库中的遗留表不删除、不静默迁移，由离线维护。
- `migrations.test.ts` 冻结 0015 checksum；`EvidenceRepository.initialize()` 只保留给测试显式调用，生产初始化只走迁移账本。

## 4. 工作包与写作用域

| 所有者 | 独占写作用域 |
| --- | --- |
| Lead | `spec/**`、`src/lib/evidence/types.ts`、`src/lib/business/contracts.ts`、`src/server/database/{migrations,migrations.test}.ts`、`src/server/results/{registry,access,template}.ts` 接线、`src/server/exports/template.ts`、`src/server/projects/{lifecycle-schema.ts,reclamation.test.ts}`、`src/instrumentation.ts`、`src/components/business/platform/project-business-workspace.tsx`、`scripts/verify-round-eight-browser.mts`、`package.json`、证据文档、提交 |
| B4 证据整理 | `src/server/evidence/**`（repository/service/http/access/report/validation + 测试）、`src/app/api/projects/[id]/evidence/**`、`src/lib/business/evidence-client.ts` 及测试、`src/components/business/platform/project-evidence-panel.tsx` 与 `evidence-*.tsx` 及测试 |
| B5 催款函 | `src/server/letters/**`（service/http/access/template + 测试）、`src/app/api/projects/[id]/letters/**`、`src/lib/business/letters-client.ts` 及测试、`src/components/business/platform/project-letters-panel.tsx` 及测试 |

Agent 之间不得互相修改作用域；共享文件只由 Lead 修改。

## 5. 冻结接口

### 5.1 证据项 HTTP（B4）

- `GET /api/projects/[id]/evidence-items`：读权限；返回 `{items: EvidenceItem[]}`（每 itemId 最新版本）。
- `POST /api/projects/[id]/evidence-items`：edit 权限；body `{operationId, itemId?, baseVersionId, reason, value: EvidenceItemDraft}`；服务端重读项目材料快照/片段与事实/款项版本，失败 422 `INVALID_SOURCE`；同 `operationId` 幂等，不同内容 409；基础版本过期 409；响应 `{item}`。

### 5.2 证据报告 HTTP（B4）

- `POST /api/projects/[id]/evidence-reports`：body `{operationId, reason, value: {cutoff, contractId?, itemVersionIds[], timeline, disputes, gaps, suggestions}}`；服务端读取所引用的证据项版本、事实版本与款项成果版本，组装 `status/scopeNotes/items` 后保存 `evidence-report` 成果；`sources` = 全部证据项来源展平，`dependencies` = 事实 `{kind:"fact"}` + 款项成果 `{kind:"result"}` + 材料 `{kind:"material"}`；返回 `ResultView`。
- `POST /api/projects/[id]/evidence-reports/[resultId]/revisions`：修订，增加 `baseVersionId`；过期 409；每次保存重跑确定性校验并恢复整份待复核。
- 读取/校验/复核/导出复用 `/results`、`/results/[resultId]/{validate,review,exports}`。

### 5.3 催款函 HTTP（B5）

- `POST /api/projects/[id]/letters`：body `{operationId, reason, value: CollectionLetterDraft}`，其中 `value` 含 `{cutoff, contractTitle, sender, recipient, demand, plannedDate, method, address, factVersionIds[], paymentResult:{resultId,versionId,sha256}, evidenceResult?:{resultId,versionId,sha256}}`；服务端重读所选版本、校验款项 `valid` 且 `unpaidFen > 0`、主体一致、事实为本项目已确认版本；渲染固定模板并保存 `collection-letter` 成果。
- `POST /api/projects/[id]/letters/[resultId]/revisions`：修订，增加 `baseVersionId`。
- 读取/校验/复核/导出复用 `/results`。
- **不提供发送接口**；页面上不出现「发送」按钮。

### 5.4 校验器与状态映射（冻结）

- `evidence-report`：结构/引用完整性（timeline/disputes/gaps 引用的证据项版本必须在 `items` 中）；`status:"incomplete"` → `partial` + `EVIDENCE_INCOMPLETE`；`status:"draft"` → `valid`；结构不符 → `invalid`。来源由通用来源校验兜底。
- `collection-letter`：模板版本固定、段落数与字段校验；`status:"draft"` → `partial` + `LETTER_INCOMPLETE`（不可批准）；`status:"ready"` → `valid`；金额必须来自所选款项版本且与其 `calculation.unpaidFen` 一致，不一致 → `invalid`。

### 5.5 导出模板（Lead 注册）

| 模板 | 正文 |
| --- | --- |
| `evidence-report-v1` | 截止日/合同/状态/范围说明/时间线/争点/证据对应表/缺证项/有条件建议 + 确定性声明，`blocksInvalidResult: true` |
| `collection-letter-v1` | 标题/收发函主体/合同依据/金额与来源/履行要求/拟发送安排/缺项标记 + AI 草稿与未发送声明，`blocksInvalidResult: true` |

## 6. 工作包验收

- **B4**：定向测试（仓储幂等/并发/跨项目/摘要篡改；服务引用不存在/跨项目/未保存证据项；报告状态派生；校验器正反例；导出正文）；`GET/POST` 权限与错误码；页面：证据项增改、链接事实与款项、生成并保存报告、重验、复核、Word 导出。
- **B5**：定向测试（缺字段→draft 不可批准；款项版本无效/非本项目/金额为 0 拒绝；正文与金额一致；模板渲染稳定；导出拦截 invalid）；页面：选版本、填计划、保存、复核、导出。
- **E2E**：新合成输入走完 审查 → 款项 → 证据 → 催款函，记录每步保存版本与导出 sha256；断裂点单列。
- **门禁**：`pnpm check`、`pnpm test`（全量）、`pnpm build`、`pnpm smoke`、`git diff --check` 全部 exit 0，测试数与原始输出如实登记。
- **证据**：`docs/reviews/2026-10-3x-round-eight-integration.md`、任务板更新、`.superpowers/round8/` 截图与下载。

## 7. 不宣称与外部缺项

- 不宣称 B 线完成度以外的东西：无 24/60 独立业务质量集、无领域规则/模板签核、无真实 OBS/GaussDB/OCR/MaaS 验证、无公网 HTTPS/CI/容器记录。
- 不宣称催款函可直接对外发送；不宣称证据报告构成法院认定事实或胜诉判断。
- 匿名文档 Agent 增量的款项/证据/催款函仍不计入项目业务验收。
- `evidence-organization` / `collection-letter` 模型任务类型仍未开放。
