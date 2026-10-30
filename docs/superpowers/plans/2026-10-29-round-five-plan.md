# EquiLens 第五轮并行实施计划（C4 界面、C6 知识发布、C5 文书起草）

> 执行说明：本文件是第五轮实施计划，沿用[总计划](2026-10-27-three-person-development-plan.md)、[第三轮计划](2026-10-29-round-three-plan.md)与[第四轮计划](2026-10-29-round-four-plan.md)的工作包编号（C4、C5、C6）；不新增未经审查的产品契约，不是完成记录，不自动创建 Issue、推送、部署或发布。
> 基线：`alaaladaka/round4/verification` @ `7867daf`（第四轮 C4 服务端闭环已合入；`pnpm test` 797 tests/796 pass/1 skip/0 fail；工作树干净）。
> 本轮目标：把 C4 从服务端闭环推进到**可用的项目界面**；交付 **C6 受控知识/规则发布**（发布仓储、私有维护入口、任务固定发布版本、停用隔离）；交付 **C5 专业分包合同与补充协议的确定性起草**（拟约定输入版本 → 固定模板填充 → 校验/复核/版本化导出）。C7 生命周期与 A5 平台验收留第六轮。

## 1. 范围

**本轮交付（P0）**

| 包 | 所有者 | 内容 |
| --- | --- | --- |
| W0 | Lead | 规格增补、`TaskManifest.publications` 与解析器接缝、ResultService server-owned 文书成果、材料快照片段读取、业务宿主壳、迁移编号、任务板、分支 |
| C4-UI | Agent B（复用 agent-b-web） | `verifications-client`、投标材料核验工作区（要求确认/手工录入、材料字段、外部核验记录、结果与导出）、只读/撤权/切换保护、浏览器验收支持 |
| C6 | Agent C（新 agent-c6-knowledge） | 发布仓储（迁移 0011）、状态机与假签核守卫、私有维护 CLI、`TaskManifest.publications` 固定、已发布规则包优先、停用隔离、reviews 运行时接入 |
| C5 | Agent D（复用 agent-a-review） | 模板目录（代码版本化）与拟约定输入版本（迁移 0012）、确定性填充、`specialty-subcontract`/`supplementary-agreement` 成果与导出、起草界面 |
| I1 | Lead | 集成、注册接线、全量门禁、浏览器验收、证据、按包提交（不推送、不部署） |

**明确不在本轮**
- C6 P1 规范库可视化维护（spec/02 边界未修订）：保留“暂无规范”空状态并登记未交付。
- C7 生命周期/对象回收/删除重放/完整恢复、A5 真机平台验收 → 第六轮。
- 真实 OCR/MaaS/OBS/GaussDB、领域规则/模板签核、投标 6 例与文书 4 例封存评测、公网 HTTPS/CI/Docker。

## 2. 分支与写作用域

共享工作目录，不并行 checkout。集成分支：`alaaladaka/round5/business`（从 `7867daf` 建立）。
每包独立提交；共享文件只能由 Lead 修改。

| 所有者 | 独占写作用域 |
| --- | --- |
| Agent B（C4-UI） | `src/lib/business/verifications-client.ts`、`src/lib/business/verifications-client.test.ts`；`src/components/business/platform/project-verification-workspace.tsx`、`verification-*.tsx`、`verification-*.test.ts`；`src/lib/business/materials-client.ts` 的快照片段只读扩展 |
| Agent C（C6） | `src/server/knowledge/**` 及测试；`scripts/knowledge-maintenance.mts`；`src/server/reviews/{input,executor,runner,runtime,registry}.ts` 与 `registry.test.ts`、`tools/contract-review/src/{pack,runner,review}.ts` 中发布包固定的最小改动 |
| Agent D（C5） | `src/server/templates/**`、`src/server/drafting/**` 及测试；`src/lib/business/drafting-client.ts` + 测试；`src/components/business/platform/project-drafting-*.tsx` + `drafting-*.test.ts`；`src/app/api/projects/[id]/drafting-inputs/**`、`drafts/**` |
| Lead | `spec/**`、`src/server/tasks/{catalog,service,repository,publications}.ts`、`src/server/results/{access,registry}.ts`（接线）、`src/server/exports/{template,access}.ts`（接线）、`src/server/materials/{service,types,http}.ts`（片段读取）、`src/server/database/migrations*`、`src/instrumentation.ts`、`package.json`、`.env.example`、`src/components/business/platform/{project-business-workspace.tsx,project-documents-workspace.tsx}`、文档、最终合并提交 |

## 3. 迁移编号（W0 冻结）

0010 已注册（C4 核验）。本轮：

| 编号 | 归属 | 表 |
| --- | --- | --- |
| 0011（本轮注册） | C6 | `equilens_publications`、`equilens_publication_versions`（发布状态/核对/摘要/停用） |
| 0012（本轮注册） | C5 | `equilens_drafting_inputs`、`equilens_drafting_input_versions`（拟约定输入不可变版本） |

- 不预建未使用表、不改 0001—0010 摘要；跨包 schema 由各自 `schema.ts` 导出语句数组，Lead 在集成分支注册并冻结 checksum。
- 仅 `CREATE TABLE`/`CREATE INDEX`；枚举与状态转换在服务层校验，条件更新断言恰好影响一行。以下 DDL 为 W0 冻结草案，落地前不再改列（checksum 永久）。
- C5 模板内容保持**代码版本化**（`src/server/templates/catalog.ts`，固定模板/字段/章节/version/sha），DB 只存拟约定输入与成果；模板 review 状态作为代码常量“待核对”展示，不伪装已签核。后续签核时再决定模板发布仓储，不在本轮新建。

**0011（C6）**

```sql
CREATE TABLE equilens_publications (
  id VARCHAR(36) PRIMARY KEY, kind VARCHAR(16) NOT NULL, artifact_id VARCHAR(128) NOT NULL,
  created_at VARCHAR(32) NOT NULL, UNIQUE(kind, artifact_id)
);
CREATE INDEX equilens_publication_artifact ON equilens_publications(kind, artifact_id);
CREATE TABLE equilens_publication_versions (
  id VARCHAR(36) PRIMARY KEY, publication_id VARCHAR(36) NOT NULL, version VARCHAR(64) NOT NULL,
  scene VARCHAR(64) NOT NULL, state VARCHAR(24) NOT NULL, sha256 VARCHAR(64) NOT NULL,
  payload_json TEXT NOT NULL, sources_json TEXT NOT NULL, applicability_json TEXT NOT NULL,
  reviewer VARCHAR(128), verified_at VARCHAR(32), review_evidence VARCHAR(500),
  published_at VARCHAR(32), disabled_at VARCHAR(32), disabled_reason VARCHAR(500),
  supersedes_id VARCHAR(36), created_by VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL,
  UNIQUE(publication_id, version)
);
CREATE INDEX equilens_publication_version_state ON equilens_publication_versions(state, verified_at);
```

状态 `draft|pending_verification|published|disabled`；`reviewer`/`verified_at`/`review_evidence` 可空以支持草拟/待核对，服务层在 `published` 转换时强制非空（缺核对人/证据/时间拒绝发布）；`sources_json`/`applicability_json` 以 `'[]'` 表示空集合是合法形态。发布版本不可变；替代=新增版本并条件停用旧版；停用保留历史。唯一约束只使用既有迁移已采用的 `UNIQUE`（0001/0005/0007），重复键按现有 provider 兼容模式处理。

**0012（C5）**

```sql
CREATE TABLE equilens_drafting_inputs (
  id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL, kind VARCHAR(32) NOT NULL,
  current_version_id VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL
);
CREATE INDEX equilens_drafting_input_project ON equilens_drafting_inputs(project_id, kind);
CREATE TABLE equilens_drafting_input_versions (
  id VARCHAR(36) PRIMARY KEY, input_id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL, version INTEGER NOT NULL, base_version_id VARCHAR(36) NOT NULL,
  operation_id VARCHAR(128) NOT NULL, request_hash VARCHAR(64) NOT NULL, sha256 VARCHAR(64) NOT NULL,
  payload_json TEXT NOT NULL, created_by VARCHAR(36) NOT NULL, created_at VARCHAR(32) NOT NULL,
  UNIQUE(project_id, operation_id)
);
CREATE INDEX equilens_drafting_version_input ON equilens_drafting_input_versions(input_id, version);
```

`UNIQUE(project_id, operation_id)` 保证幂等；重复键按现有 provider 兼容模式处理（同输入返回原版本，同 operationId 不同输入 409）。`equilens_drafting_input_versions` 的 `(input_id, version)` 唯一性由服务层条件插入保证（同一 input 版本号单调）。

## 4. W0 冻结接口（Lead 实现，B/C/D 消费）

### 4.1 规格增补（先改规格再实现）

- `spec/01-product.md` §4.4：追加项目接入段——拟约定输入保存为不可变版本；确定性模板填充不调用模型；缺失字段保留 `【待补充】` 草稿标记；补充协议固定原合同版本；模板/字段版本与 status 进入结果与导出。**本轮中期边界**：模板为代码目录且固定“待核对”，不得显示为已核对/已发布；未核对模板生成的文书只到 `partial` 草稿，不得批准为完整复核成果；正文/章节人工编辑与催款函不在本轮交付（催款函内容属 B 线），须在规格与验收中如实标注，不宣称 AC-05 整项。
- `spec/01-product.md` 新增 §8.2.4「项目文书起草成果」：`specialty-subcontract`/`supplementary-agreement` 两种人工文书成果；server-owned 唯一写入路径（浏览器普通成果 POST 不可写）；校验器（结构/必填/条件必填/模板 sha/重渲染一致/原合同归属）与 valid/partial/invalid 策略；导出模板 `specialty-subcontract-v1`/`supplementary-agreement-v1`；partial 草稿可导出、invalid 禁止；模板升级不改旧字节。写明“待核对模板 ⇒ partial，不产生可批准的完整成果”和“本轮只做字段重渲染，不含正文编辑”。
- `spec/01-product.md` §8.2.2：合同审查 published 模式校验策略——执行器在保存前已核对 DB 固定发布版本/摘要；validator 校验结果内嵌的固定引用（`PublishedRef` 数组、kind/versionId/sha256 结构）、与 `mode:"published"` 的一致性、覆盖与来源；缺少内嵌固定引用、结构不符或裸声明 published 仍为 invalid；无发布 pin 时保持 debug/未签核。现有“非 debug 即 invalid”规则按此修订（`reviews/registry.ts` 由 C6 负责）。
- `spec/01-product.md` §7.1：受控发布仓储（草拟/待核对/已发布/已停用）、私有 CLI 维护入口、发布要求（来源/核对人/核对时间/期望摘要/允许清单/核对人≠操作者、操作者须为现有启用超级管理员）、已发布不可变与替代/停用、任务固定发布版本、**解析器三态**（`pinned` 固定 / `none` 仅在从未有发布历史时允许现有 debug 路径 / `blocked` 在存在待核对或已停用版本时于入库前拒绝）、停用后新任务拒绝、旧任务按固定版本执行并标注依据已停用。
- `spec/01-product.md` §9.1：任务输入清单新增 `publications`（服务端解析写入，浏览器不可提交）；无已发布依据的合同审查保持 debug/未签核路径，不伪造 published。
- `spec/02-workbench-ui.md` §5.1/§5.7：业务处理内业务选择（合同审查 / 投标材料核验 / 文书起草），补核验与起草的输入/状态/只读/空状态/导出交互；§3 规范库边界不变（P1 未交付）。
- `spec/04-database-deployment.md`：登记 0011/0012；说明发布版本为全局数据（不随项目删除，C7 清单使用）、拟约定输入为项目私有数据。

### 4.2 任务输入固定（`src/server/tasks/publications.ts` + `catalog.ts` + `tasks/{service,repository}.ts`）

```ts
export type PublicationPin = { rules: PublishedRef[]; knowledge: PublishedRef[]; templates: PublishedRef[] }
export type PublicationResolution =
  | { state: "pinned"; pin: PublicationPin }
  | { state: "none" }                       // 该 kind/场景从未有过发布历史 → 维持现有 debug/未签核路径
  | { state: "blocked"; reason: string }    // 存在待核对/已停用/歧义版本 → 入库前拒绝
export type PublicationResolver = (input: { kind: TaskKind; projectId: string; refs: Record<string, unknown>; conditions: Record<string, unknown> }) => Promise<PublicationResolution>
export function registerPublicationResolver(resolver: PublicationResolver): void
export function resolvePublication(input: Parameters<PublicationResolver>[0]): Promise<PublicationResolution>
```

- `TaskManifest` 追加可选 `publications?: PublicationPin`（`manifest.version` 保持 1；旧 manifest 无该字段仍可解析）；浏览器提交仍只有 `kind/projectId/refs/conditions`，HTTP 白名单不变（加测试）。
- 精确接缝：`buildTaskManifest(request, submittedBy, submittedAt, publications?)`；`TaskRepository.submit(owner, operationId, request, options?: { publications?: PublicationPin })` 把 pin 写入 manifest；`TaskService.submitTask` 在入库前调用 `resolvePublication`：`blocked` 抛 `TaskError(422/503)` 不入库，`pinned` 传 pin，`none` 不传；幂等摘要仍按浏览器输入计算（同 operationId 重放得到原任务与原 pin）。
- `TASK_CATALOG_VERSION` 3 → 4（manifest 增加 publications 字段）；补 catalog/旧 manifest 解析测试。
- 启动顺序：C6 的 `startKnowledgeRuntime()` 在 `src/instrumentation.ts` 中先于 `startTaskRunner()` 注册解析器（导入不启动）；解析器未注册时任务提交抛 `TaskError(503 SERVICE_UNAVAILABLE)`（fail-closed，绝不在已存在发布历史的库上静默降级为 debug）；启动/测试断言注册完成。
- 无已发布依据时 `none`：合同审查保持现有 debug/未签核行为；`blocked` 与 formal 发布语义按 §7.1；不伪造 published。

### 4.3 文书成果受控写入（Lead 改 `results/access.ts`、`results/registry.ts`、`exports/template.ts`）

- `ResultService`：machine-only 集合追加 `specialty-subcontract`、`supplementary-agreement`（浏览器普通成果 POST 不可写）；server-owned 集合追加两类（C5 `DraftingService` 用 `saveResultRevision(..., undefined, { serverOwned: true })` 写入人工拟约定成果）。
- 校验器 `specialtySubcontractValidator`、`supplementaryAgreementValidator`（Agent D 交付，Lead 注册）：结构、必填/条件必填、模板 id/version/sha、出资金额十进制字符串、重渲染一致（防浏览器伪造段落）、原合同版本归属；**模板固定“待核对” ⇒ 结果状态 `partial`，不可批准为完整复核成果**，warning `TEMPLATE_UNREVIEWED` 持续展示；人工复核可驳回/退回，但不能把待核对模板草稿升为完整成果。本轮只做字段重渲染，正文/章节人工编辑不在本轮（记入未运行项）。
- 导出模板 `specialty-subcontract-v1`/`supplementary-agreement-v1`（Agent D 交付，Lead 注册）：只读结果 value 渲染，`blocksInvalidResult: true`，`originNote: "人工拟约定输入，确定性模板填充"`；partial 草稿导出保留缺失标记与模板“待核对”。
- 成果依赖：模板 `{kind:"template", id:templateId, versionId:version}`、原合同 `{kind:"material"|"result"}`、拟约定输入版本信息内嵌 value；旧导出字节不因模板升级改变。

### 4.4 材料快照片段读取（Lead 改 `materials/service.ts`、`materials/http.ts` 与客户端类型）

- `readParseSnapshot` 增补 `fragments: SourceFragmentRecord[]`（按 order 排序，含 id/kind/page/paragraph/table 行列/text/headingPath）；既有 `{snapshot, material, version}` 为新增字段，不破坏既有消费方。
- `GET /api/projects/[id]/materials/[materialId]/snapshots/[snapshotId]` 返回上述结构；仍按项目授权、私有 no-store；只读成员可读。
- C4-UI 的 `materials-client.ts` 增补快照读取（含片段）用于手工录入要求的来源选择。

### 4.5 业务宿主（Lead 在集成时接线）

- 新增 `src/components/business/platform/project-business-workspace.tsx`：官方 Tabs 的子页签「合同审查 / 投标材料核验 / 文书起草」，复用 `ProjectReviewWorkspace` 并挂载 `ProjectVerificationWorkspace`（B）与 `ProjectDraftingWorkspace`（D）；保持现有 props 语义（project/active/canEdit/canManage/blocked/isCurrent/onAccessInvalid/onOpenDocuments/registry），嵌套页签使用 `forceMount` 保留未提交输入；`project-documents-workspace.tsx` 的「业务处理」页签改为渲染宿主；不新增顶层页签（spec/02 §5.7）。切换页签/项目前的未保存保护沿用 `UnsavedRegistry`。

### 4.6 浏览器验收（Lead）

- 使用本机 Edge（browser-use 技能）验证：业务选择器；核验工作区手工路径（上传/解析→字段登记→要求录入→比较任务→结果两组状态→复核/驳回→导出草稿下载）；文书起草（填字段→保存拟约定输入→生成草稿→缺字段草稿标记→补齐→复核（待核对模板下只能驳回/退回，不可批准）→导出草稿）；只读/撤权与错误文案；迟到响应不进入新项目。
- 若真实模型不可用，核验的“机器候选”路径单列为未运行；手工路径必须跑通。截图与原始日志保存在忽略目录 `.superpowers/round5/`。

## 5. 工作包

### C4-UI（Agent B）

- [ ] `verifications-client.ts`：任务提交/轮询、`GET /verifications` 列表/详情、要求集服务端保存、字段读取/登记、外部记录追加、结果 validate/review/export/download；错误码映射（401/403/404/409/422/429/503）、只读不写。
- [ ] `project-verification-workspace.tsx`：业务选择由宿主提供；材料选择（仅已解析快照/证照信息）、要求候选列表（来自 `bid-requirements` 成果）与手工录入（快照片段选择 + 逐字引用）、材料字段读取/人工登记/更正、外部核验记录（来源/时间/操作者/条件/结论/证明）、比较任务提交与真实状态、结果两组状态分列、未完成项、校验/复核/导出；空状态只命名缺失资源；只读成员隐藏写操作；切换/迟到响应隔离；`registry` 未保存登记。
- [ ] `materials-client.ts` 快照读取扩展与类型。
- [ ] 测试：client 请求/错误映射、任务轮询停止、要求/字段表单状态机、只读与撤权、导出失败提示；组件生命周期以纯逻辑测试覆盖；不新增顶层页签。
- [ ] 浏览器验收由 Lead 执行；B 提供稳定 DOM 标识/可访问名称（roles/labels）与合成输入准备说明。

### C6（Agent C）

- [ ] `src/server/knowledge/{types,schema,repository,publication,service,resolver,access,runtime}.ts`：发布状态机（draft/pending_verification/published/disabled）、不可变版本与摘要、替代/停用、核对人与时间、`EQUILENS_DOMAIN_REVIEWERS` 允许清单、核对人≠操作者、操作者须为现有启用超级管理员（失败即拒绝且不改状态）、假签核/缺来源/来源未发布拒绝、路径形状内容拒绝、存储不含文件路径、条件更新断言一行。
- [ ] 解析器三态 `pinned|none|blocked`：`none` 仅在该 kind/场景从未有发布历史时返回；存在待核对/已停用/歧义版本 → `blocked`（任务提交 422/503 且不入库）；停用后旧任务按固定版本执行并带“依据已停用”警告。
- [ ] `reviews/registry.ts` + `registry.test.ts`：执行器在保存前已核对 DB 固定版本/摘要；validator 校验结果内嵌引用（`PublishedRef` 结构、sha256）与 `mode:"published"` 一致性，缺少内嵌固定引用或裸声明 published 仍 invalid；无 pin 保持 debug/未签核。`reviews/{input,executor,runner,runtime}.ts` 传递 pin 并在依赖中记录固定引用。
- [ ] 私有维护入口 `scripts/knowledge-maintenance.mts`（`list|validate|submit|publish|disable|show`）：显式数据库初始化、无 HTTP 写路由、脱敏输出；加入构建脚本清单（A5 打包前可运行）。
- [ ] 发布解析器：`registerPublicationResolver` 返回已发布 pack 的 `PublishedRef`（按场景）；任务提交时固定；停用后新任务拒绝、旧任务按固定版本执行并带“依据已停用”警告。
- [ ] reviews 接入：runner 通过注入 `loadPublishedPack(ref)` 读取 DB pack；有 pin 时 `mode:"published"`、只用该场景发布规则；无 pin 保持现有 debug/未签核路径；依赖记录使用固定引用。
- [ ] 迁移 0011：两张表 + 唯一约束 + 索引；`migrations.test.ts` 对 0011 与 0012 均加空库应用、重复启动、checksum 冻结、回滚与 0001—0010 摘要不变断言（Lead 注册）。
- [ ] 测试：状态机/不可变/假签核/未发布来源/摘要不符/停用隔离/旧任务固定/任务清单 pin/浏览器不可提交 publications/跨目录与跨项目读取拒绝/无写 HTTP 路由；**draft 与 pending_verification 可在 `reviewer`/`verified_at`/`review_evidence` 为空时创建；`published` 转换缺少核对人/时间/证据/期望 sha 时拒绝且不改状态**。

### C5（Agent D）

- [ ] `src/server/templates/catalog.ts`：固定模板目录（id/version/sha/章节/必填与条件必填字段/标签/来源门槛），`specialty-subcontract-v1`、`supplementary-agreement-v1`；模板状态固定“待核对”；代码版本化，不建模板发布表。
- [ ] `src/server/templates/{schema,repository}.ts` + 迁移 0012：拟约定输入（`drafting_inputs` + 不可变 `drafting_input_versions`，operationId/baseVersionId/sha256/摘要幂等）。
- [ ] `src/server/drafting/{service,render,validation,export-template}.ts`：保存输入版本；生成草稿（确定性渲染，缺失字段 `【待补充：标签】` 进入 `missing`，不补造主体/证号/金额/日期/条款号；**只做字段重渲染，不接受浏览器正文/章节编辑**）；补充协议必须固定本项目原合同版本（material 或 result `specialty-subcontract`，跨项目/缺失拒绝）；经 server-owned A4 保存人工成果；修订基于 baseVersionId 重渲染并重置整份复核；模板升级不改旧成果；模板固定“待核对” ⇒ 结果 partial、不可批准为完整成果。
- [ ] 两个校验器与两个导出模板：结构/必填/条件必填/模板 sha/重渲染一致/原合同归属；`blocksInvalidResult`；partial 草稿可导出、invalid 禁止；旧导出字节不变；催款函不在本轮交付（B 线内容），登记未运行。
- [ ] `drafting-client.ts` + `project-drafting-workspace.tsx`：字段表单（必填/条件必填/来源标签）、保存拟约定输入与生成草稿分步、缺失项提示、结果校验/复核/导出、只读/撤权/切换保护、空状态；不另建顶层页签。
- [ ] 路由：`GET/POST /api/projects/[id]/drafting-inputs`、`GET .../[inputId]`、`POST /api/projects/[id]/drafts`、`POST /api/projects/[id]/drafts/[resultId]/revisions`；Node runtime、no-store、同源、逐次授权、跨项目 404、只读 403。
- [ ] 测试：模板目录/sha；输入幂等/409/跨项目；渲染缺失字段/条件字段/不补造；原合同归属；server-owned 唯一写路径（普通 POST 403）；valid/partial/invalid × 复核/导出矩阵；旧模板升级不改旧字节；HTTP 401/403/404/只读/no-store。

## 6. 合入顺序、门禁与证据

1. W0（Lead）：分支、规格（含 published 策略、模板中期边界、三态解析器）、0011/0012 DDL 冻结（唯一约束、可空核对字段）、`tasks/{catalog,service,repository,publications}.ts` 接缝（`buildTaskManifest(..., publications?)`、`TaskRepository.submit(..., options?)`、解析器 fail-closed）、ResultService 集合、材料片段、迁移编号、测试 fixture、`TASK_CATALOG_VERSION` 4；DDL 由独立 reviewer 复核后才注册；`pnpm check`/`tsc` 基线通过后开工。
2. 并行执行 C4-UI / C6 / C5（写作用域互斥；宿主壳与注册接线由 Lead 在集成时完成）。
3. 合入顺序：C6 → C5 → C4-UI（C5 依赖 server-owned 集合与迁移；C4-UI 依赖片段读取；三者文件互斥，按提交隔离）。每包完成后 Lead 按路径提交并跑定向检查。
4. 独立交叉审查（另一 Agent 或独立 reviewer）核对冻结契约与证据；BLOCKER 修复后复核。
5. 门禁：`pnpm check`、`pnpm test`、`pnpm build`、`pnpm smoke http://127.0.0.1:3000`、`git diff --check` 全部 exit 0；测试数如实记录；不并发重跑 `.next`；`package.json` 测试路径加入 `src/server/knowledge/*.test.ts`、`src/server/templates/*.test.ts`、`src/server/drafting/*.test.ts`；`.env.example`/README 记录 `EQUILENS_DOMAIN_REVIEWERS`、发布 CLI 与“无真实发布/无签核”边界。
6. 浏览器验收（§4.6）：本地 dev 服务 + 临时/既有合成数据库；只记录实际观察，失败路径单列；截图/日志在 `.superpowers/round5/`。
7. 证据：`docs/reviews/2026-10-29-round-five-c4-ui.md`、`-c6.md`、`-c5.md`、`2026-10-29-round-five-integration.md`、任务板；区分本地 Windows/SQLite/合成存储与未运行真机项。

## 7. 不宣称与外部缺项

- 真实 OCR/证照种类、真实模型要求提取、真实 OBS/MaaS、GaussDB、公网 HTTPS、CI 运行、Docker/Linux：未验证，保持缺项；不把合成结果当真实服务证据。
- 领域规则/模板未签核：无真实 published pack、无模板法律核对；C6 只交付受控机制与测试，测试注入的发布版本是合成夹具并须在证据中标注，不得表述为已发布法律规则；C5 文书始终“待核对模板 + 草稿（partial）”，不宣称 AC-05/AC-21 整项通过或法律质量。
- C5 本轮只交付字段重渲染；正文/章节人工编辑、催款函（B 线内容）未交付并单列未运行。
- 规范库 UI（C6 P1）未交付，保留空状态；6 例投标与 4 例文书封存评测、24 例 Demo 业务集未运行。
- AC-05、AC-07、AC-11、AC-22、UI-23 整项不做通过声明；本轮只按已执行证据说明支持范围。
- 浏览器验收只覆盖本机 Edge/合成数据；IE/移动端/真实 Word 排版不宣称。
- 材料快照片段读取为增量字段，可能返回较大 payload（受解析文本上限约束）；本机验证，不承诺真实大文件性能。

## 8. 后续轮次（暂定，下一轮重新规划与审查）

- 第六轮：C7（生命周期 0013、对象回收、删除记录重放、完整恢复）+ A5（SQLite 备份恢复、卷式重启、5 用户并发/队列容量、smoke、CI/部署事实登记与缺项、全量门禁与证据汇总）。
- 第七轮（如需要）：A/C 全量验收证据、AC 对照表、未通过项与外部缺项汇总；全部工作包完成即停止。

## 9. 每包完成定义（DoD）

- 行为测试先写：必填/权限/版本/状态/失败路径正常与反例；不写只镜像实现的无意义测试。
- 实现真实持久化、授权守卫与既有生命周期，不新增独立服务/队列/开放 Agent 平台。
- 定向测试 + 受影响回归通过；证据写实际命令、样本、失败与未运行项。
- 交指定审查人；BLOCKER 修复后独立复核；只有实际执行的检查可写通过。
