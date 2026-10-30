# EquiLens 第七轮并行实施计划（B 线：项目事实、款项核对与审查成果人工修订）

> 执行说明：本文件是 B 线第一段实施计划，沿用[总计划](2026-10-27-three-person-development-plan.md)与乙的[主线计划](2026-10-27-person-007350-mainline-plan.md)工作包编号（B1a/B3a/B2b）；不新增未经审查的产品契约，不是完成记录，不自动创建 Issue、推送、部署或发布。
> 基线：`alaaladaka/round6/lifecycle` @ `1aeba23`，叠加基线提交 A0（第四/五轮与第六轮执行代码核验修复合并提交，或按 §2 的并发工作流状态拆分，见 §2）。
> 本轮目标：把 B 线从“未接线的领域层”推进为**正式项目主线第一段**：
> 1. **B1a** 项目事实：事实准备任务（`document-analysis`）→ 候选事实机器成果 → 人工确认/更正为不可变事实版本 → 项目事实 HTTP/UI；
> 2. **B3a** 项目款项核对：人工核对的款项表 → 服务端确定性计算 → 项目成果（`payment-reconciliation`）→ 重验/复核/版本化 Word 导出；
> 3. **B2b** 合同审查成果逐条人工修订（发现项采纳/驳回/修订 + 理由，另存不可变修订版本并重验/复核/导出）。
>
> B4 证据整理、B5 催款函、四业务主线端到端演练与 B 线验收留第八轮（见 §8）。本轮不宣称 B 线完成，不宣称 AC-06/19/20 整项通过。

## 1. 范围

| 包 | 所有者 | 内容 |
| --- | --- | --- |
| W0 | Lead | 基线收尾、规格增补（事实/款项/B2b）、迁移 0014、`document-analysis` 任务类型冻结、共享 DTO 与注册表、任务板、分支 |
| B1a | Agent A | 项目事实服务/HTTP/UI、`document-analysis` 事实准备执行器、候选成果校验器、迁移账本内建表、撤权/冲突/跨项目守护 |
| B3a | Agent B | 款项核对服务/HTTP/UI、`payment-reconciliation` 成果值/校验器/导出模板、确定性计算接线、只读/冲突/旧版本守护 |
| B2b | Agent C | `contract-review` 成果人工修订（发现项决定/理由/修订建议）、校验器扩展、报告导出标注、审查工作区编辑 UI |
| I1 | Lead | 注册表/运行时接线、C7 覆盖测试适配、浏览器验收、全量门禁、证据与提交 |
| Review | 独立交叉审查 | B1a/B3a/B2b 实现与证据（只读） |

**明确不在本轮**

- B4 项目证据整理成果、B5 催款函项目流程与模板内容、四业务主线端到端演练、B 线验收记录 → 第八轮。
- 开放 `payment-reconciliation`/`evidence-organization`/`collection-letter`/`result-export` 任务类型；本轮款项核对走 A4 成果路径（人工核对 + 服务端确定性计算），不冒充模型整理任务。
- 匿名文档 Agent 增量（`/api/contract-reviews` 的款项/证据/催款函）保持现状，不迁移、不改写其契约。
- 真实 GaussDB/OBS/OCR/MaaS 验收、公网 HTTPS、GitHub CI、Docker/Linux 容器、领域规则/模板签核、24/60 独立业务质量集、自动外发催款函。

## 2. 基线收尾、并发写者与分支（W0 前置，需用户确认）

**当前工作树不是干净基线**，且本计划起草期间出现**另一并发工作流的未提交改动**（`.superpowers/round6-review-20261030/`、`docs/superpowers/plans/2026-10-30-round-six-fixes.md`，涉及 `spec/04-database-deployment.md`、`src/server/projects/{lifecycle,reclamation,reclamation.test}.ts`、`src/server/database/connection.ts`、`docs/{deployment,operations}.md`、`scripts/*` 及新测试）。该工作流仍在写同一工作区。因此：

1. **并发写者门禁（阻断）**：W0 开始前必须确认该工作流已停止/完成；若仍有活动写者，暂停 B 轮执行与任何 `git add/commit`，先由用户确认其状态。第二次并发核对以本计划 W0 执行时的 `git status --porcelain` 与最近 10 分钟文件 mtime 为准，写入证据文档。
2. 基线提交（均为本地提交，不推送、不部署，**需用户明确授权后执行**）。由于 `spec/01-product.md` 当前同时含第四/五轮 3 行与第六轮 6 行修复（`git diff --numstat` 为 9+/0-），默认采用**单个 A0 提交**，避免用 `git add -p` 拆 hunk 的风险：提交信息 `fix: harden verification, drafting, lifecycle and restore checks (round four–six review fixes)`，路径为实际工作树中的两批修复文件 + 本计划文档 + 第六轮计划/记录文档（以提交时 `git status --porcelain` 逐项核对为准）。
   - 若并发工作流先自行提交其第六轮修复，则 A0 拆为 A0a（仅剩余第四/五轮修复，`spec/01-product.md` 此时只剩 3 行）与 A0b（已由对方提交）；提交信息分别覆盖。
   - 禁止默认使用 `git add -p` 拆 hunk；如用户明确要求拆分，必须先输出 hunk 清单并核对 3 行/6 行分界后再暂存。
3. 基线空树门禁：A0 提交后 `git status --porcelain` 必须为空；若有残留（本计划文档、并发工作流新增文件等），逐项列明并纳入 A0 或单独 docs 提交后再判定，未通过不建立分支、不开始 W0。随后从 A0 建立集成分支 `alaaladaka/round7/mainline`。若用户要求保留未提交状态，可 `git reset --soft` 回退，不影响本轮后续按路径提交。
4. 基线门禁：A0 提交后重跑 `pnpm check` 与 `pnpm test` 并记录实际数字；本轮不把起草时的 968/966/2 skip 结果当作提交后新结果，也不重跑完整构建/冒烟（由 I1 统一执行）。

## 3. 分支与写作用域

共享工作目录，不并行 checkout。共享文件只由 Lead 修改；Agent 需要改动时先通知 Lead。

| 所有者 | 独占写作用域 |
| --- | --- |
| Agent A（B1a） | `src/server/facts/**`（含 `runtime.ts`、`input.ts`、`service.ts`、`http.ts`、`access.ts`、`result-validator.ts`、测试）、`src/app/api/projects/[id]/facts/**`、`src/lib/business/facts-client.ts` 及测试、`src/components/business/platform/project-facts-panel.tsx` 与 `fact-*.tsx` 及测试；只读复用 `verification-fragment-picker.tsx` |
| Agent B（B3a） | `src/server/payments/**`（含 `service.ts`、`http.ts`、`access.ts`、`result-validator.ts`、`export-template.ts`、测试）、`src/app/api/projects/[id]/payments/**`、`src/lib/business/payments-client.ts` 及测试、`src/components/business/platform/project-payments-panel.tsx` 与 `payment-*.tsx` 及测试 |
| Agent C（B2b） | `src/server/reviews/{registry,export-template}.ts` 及测试、`src/lib/business/reviews-client.ts` 及测试、`src/components/business/platform/{project-review-workspace.tsx,review-result-panel.tsx,review-draft.ts,review-state.ts}` 及测试、`src/components/business/platform/project-review-workspace.test.ts` 等定向测试 |
| Lead | `spec/**`、`src/lib/facts/types.ts`、`src/lib/payments/types.ts`、`src/lib/business/contracts.ts`、`src/server/tasks/{catalog,admission,catalog.test,test-fixtures}.ts` 及受 catalog 4→5 影响的 `src/server/tasks/{repository,budget,estimates}*.test.ts`、`src/server/database/{migrations.ts,migrations.test.ts}`、`src/server/results/{registry,access,service}.ts` 及其 `{registry,service,http}.test.ts`、`src/server/exports/{template.ts,template.test.ts}`、`src/server/verification-fields.ts`（若需抽取 `quotesMatch`）、`src/server/document-agent/{projection.ts,projection.test.ts}`（0014 兼容）、`src/instrumentation.ts`、`src/components/business/platform/project-business-workspace.tsx`、`src/components/business/platform/project-payments-workspace.tsx`（新建组合壳）、`src/server/projects/{lifecycle-schema.ts,reclamation.test.ts}`（C7 覆盖常量与断言适配）、`scripts/verify-round-seven-browser.mts`、`package.json`、证据文档、最终提交 |
| Review | 只读审查，不写文件（审查意见以消息/记录交付 Lead） |

Agent 之间不得互相修改对方作用域；`src/components/business/platform/project-business-workspace.tsx` 与新增组合壳由 Lead 统一接线，两个面板按 §4.8 冻结 props 独立实现。

## 4. W0 冻结接口

### 4.1 规格增补（先改规格再实现，Lead 执行）

**`spec/01-product.md`**

- §4.5 新增「项目款项核对（正式项目主线）」：事实准备任务从所选已提交材料版本的不可变解析快照提取候选事实并逐字引用片段；引用不能定位的候选拒绝；任务成功不等于事实已确认。人工确认/更正保存为不可变事实版本，保留原值、理由、来源性质和冲突；人工确认不清除材料冲突。款项表按合同/期次/金额性质/本期或累计/税口径/到期条件/来源人工核对录入；未确认行、口径冲突、缺到期证据只形成草案；已到期未付 = 同一口径累计已到期应付净额 − 已核实付款，不直接以计量额相减，已计入净额的扣项不重复扣减，负值保留并提示。金额由服务端确定性计算并随保存版本重验；浏览器只提交行值与来源，不提交公式、合计或计算结果。只读成员只读；保存/复核/导出逐次重验项目权限。验收对应 AC-06/07/08/09/10/11/15/19/20/22。
- §4.2 补充：已保存审查成果可由人工对发现项采纳/驳回/修订建议并填写理由，形成新的不可变修订版本；机器原始发现与引文不可改写，整份复核针对所选保存版本，修改后恢复待复核。
- §8.2.2 扩展：`contract-review` 人工修订契约——只允许对已存在机器成果另存修订；机器字段（findings 的 ruleId/category/quote/citations/paragraphIndex、coverage、input、status、rejected/notLocated 等）与 sources/dependencies 由服务端固定为上一版本值，浏览器只能新增 `findingDecisions`；保存时对“去掉 findingDecisions 的投影”做 canonical JSON 全等比较，不等即 422 拒绝；保存重验引文/必填项并恢复待复核；报告显示处理决定与修订建议；新增导出模板版本 `contract-review-report-v2`（旧 v1 导出文件与历史版本不变，模板升级按 §8.2.1 创建新导出）。
- §8.2.5「项目事实准备成果」：`fact-candidates` 机器成果的 value 结构、来源逐字校验、候选/拒绝/覆盖清单；只读（人工确认走事实保存，不直接修改机器成果）；无导出；服务端 `noReviewKinds` 禁止对该 kind 复核/批准（不只是 UI 隐藏）。
- 事实语义唯一拥有者仍为 §8.3（事实身份/来源/使用门槛）与 §8.1（新分析/版本链）；新增 §8.2.6「项目事实版本」**只**补充项目 HTTP/写入契约（路由、幂等、基础版本并发、权限、错误码），不重复定义语义；冲突时以 §8.3/§8.1 为准。
- 新增 §8.2.7「项目款项核对成果」：kind `payment-reconciliation`；唯一写入路径是服务端受控款项服务；value 内嵌截止日、行、事实引用、程序计算与说明；校验器重算并拒绝篡改；确定性计算不调用模型；`status` 仅 `conditional`（可计算）或 `draft`（不可计算）；人工修订形成新版本并重置整份复核；导出模板 `payment-reconciliation-v1` 只读所选保存版本；不批准无效引用/关键数值不符。
- §9 新增 §9.4「项目事实准备任务」：kind `document-analysis`，refs 固定 1—5 个已提交材料版本 `{materials:[{materialVersionId,sha256}]}`，conditions 固定 `{asOf?, externalProcessingConsent:true}`；最多 3 次模型请求、成本上限 300 分；执行器逐阶段重验授权/保留期/摘要，只消费不可变解析快照；引用必须逐字存在于对应快照片段，否则候选拒绝并如实记录；失败/部分完成/无候选不得伪装成功；不写事实，只写机器候选成果。
- §9.1 更新开放任务类型：`material-parse`、`contract-review`、`document-analysis`（事实准备）与 §9.3 三类投标核验；`payment-reconciliation`、`evidence-organization`、`collection-letter`、`result-export` 仍 503 且不入库。

**`spec/02-workbench-ui.md`**

- §5.1 业务处理业务选择增加「款项核对」，并描述页签内两个区域：**项目事实**（选择已解析材料版本、提交事实准备任务、候选确认/更正保存为事实版本、事实列表与历史、冲突/待核实高亮）与**款项表**（行编辑、来源选择、事实引用、确定性计算展示、保存成果、重验/复核/Word 导出）；只读成员只读；空状态只命名缺失资源。
- §5.1 合同审查补充：发现项逐条处理（采纳/驳回/修订 + 理由 + 修订建议），保存为新的成果修订版本后重新校验并恢复待复核；机器原始内容保留可读。
- §5.2 事实准备改为项目主线描述：准备事实任务与开始分析分离；候选事实须人工确认才成为事实版本，不把任务成功当作事实已确认。
- §5.4 补充发现项处理状态与整份复核分离，处理决定随修订版本保存。
- §5.5 补充款项表保存冲突、重验、复核与导出门槛；无效引用/关键数值不符不得批准或导出。
- §5.7 注明：匿名文档 Agent 增量保持既有入口；项目款项核对为正式项目主线入口，两者不共享成果、不互相冒充。

**`spec/04-database-deployment.md`**

- 第七轮迁移分配：事实表使用 0014，运行时建表迁入迁移账本；只 `CREATE TABLE`/`CREATE INDEX`，不依赖 CHECK/CTE/RETURNING；项目权限与状态由服务层校验；事实表纳入项目删除与恢复清单（C7 清单已列，登记后不再“存在才删/缺失跳过”）。

**`src/lib/business/contracts.ts`**：删除“乙 saveFactRevision / calculateLedger 仍待冻结”的过期说明，加入本轮冻结的项目事实/款项 HTTP DTO 类型（§4.4/§4.5），并注明服务端唯一写入路径与错误码。

### 4.2 迁移 0014（Lead 注册并冻结 checksum）

```sql
CREATE TABLE equilens_fact_versions (
  id VARCHAR(36) PRIMARY KEY,
  fact_id VARCHAR(36) NOT NULL,
  project_id VARCHAR(64) NOT NULL,
  contract_id VARCHAR(64),
  version INTEGER NOT NULL,
  supersedes_version_id VARCHAR(36),
  operation_id VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(fact_id, version),
  UNIQUE(project_id, operation_id)
);
CREATE INDEX equilens_fact_version_project ON equilens_fact_versions(project_id, contract_id, fact_id, version);
```

- `migrations.test.ts` 冻结表追加 0014 checksum；`0001—0013` 不改写。
- `src/server/facts/repository.ts` 的 `initialize()` 运行时 DDL 停止在生产路径使用（测试可显式调用迁移）；生产初始化只走迁移账本。
- **既有匿名投影兼容（W0 冻结签名）**：`FactRepository`（Agent A）保留兼容签名 `save(projectId, input, options?: { operationId?: string; requestHash?: string })`；未提供 options 时由仓储在生成 `factVersionId` 后内部写入 `operationId = legacy:<factVersionId>` 并计算 `requestHash`（同一输入重复调用各自生成新版本，旧匿名投影语义不变）；生产事实服务始终显式传入 operationId。`src/server/document-agent/projection.ts` 属 Lead，仅做必要适配；`projection.test.ts` 改用 0014 迁移建库（不再用 `initialize()` 旧 DDL），并新增“legacy 写入 operation_id 非空且唯一”断言。该文件不属于生产接线，不得借机接入任务工作流。
- **旧运行时表升级说明**：已核对本机 `data/equilens.sqlite` 仅有 0001—0009，生产从未调用 facts `initialize()`，不存在旧表；若他处存在旧运行时 facts 表，0014 的 `CREATE TABLE` 会失败并如实阻止业务就绪，不做静默 `ALTER/IF NOT EXISTS`，由离线维护处理并在证据中记录。
- C7 适配：迁移 0014 后 `PROJECT_RUNTIME_TABLES` 移除 facts 表（改为账本表），`reclamation.test.ts` 用迁移建库并 seed 事实行，断言删除覆盖；不再断言“facts 缺失时 skipped”。

### 4.3 任务类型（Lead 修改 `src/server/tasks/catalog.ts`）

- `TASK_CATALOG_VERSION` 4 → 5。
- `document-analysis` 定义替换为事实准备：

```ts
"document-analysis": {
  maxCalls: 3, maxCostFen: 300,
  refs: z.object({ materials: materialRefs.length(1).max(5) }).strict(),
  conditions: z.object({ asOf: day.optional(), externalProcessingConsent: z.literal(true) }).strict(),
}
```

- 其余 kind 定义不变；`payment-reconciliation`/`evidence-organization`/`collection-letter`/`result-export` 继续无执行器 → 提交 503。
- 更新 `catalog.test.ts`、`test-fixtures.ts` 等受影响断言；`document-analysis` 任务提交仍经 `POST /api/tasks`（Idempotency-Key、服务端 manifest、预算预留）。
- 不新增 admission 钩子；执行器注册即能力门禁（与 A4c 一致）。模型配置缺失时任务如实失败，不伪造候选。

### 4.4 项目事实 DTO 与 HTTP（Agent A 实现，接口冻结）

共享类型（Lead 在 `src/lib/facts/types.ts` / `src/lib/business/contracts.ts` 冻结）：

```ts
// 项目材料来源锚点；匿名文档来源字段保留以兼容既有增量/投影测试
export type SourceAnchor = {
  projectId: string
  quote: string
  locator?: string
  parseSnapshotId: string
  fragmentId?: string
  paragraphIndex?: number
  materialId?: string
  materialVersionId?: string
  documentId?: string
  documentVersionId?: string
}

export type ProjectFactDraft = {
  contractId?: string
  subject?: string
  field: string
  occurredAt?: string
  periodStart?: string
  periodEnd?: string
  nature: "材料记载" | "人工陈述" | "拟约定" | "程序计算"
  originalValue?: string
  candidates?: string[]
  selectedValue?: string
  unit?: string
  caliber?: string
  sources: SourceAnchor[]
  conflicts: SourceAnchor[]
  confirmation: "未确认" | "已确认" | "待核实"
  support: "材料支持" | "仅人工陈述" | "材料冲突" | "缺少支持"
  reason?: string
}
export type ProjectFactVersion = ProjectFactDraft & {
  projectId: string; factId: string; factVersionId: string; version: number
  supersedesVersionId?: string; sha256: string; createdAt: string; createdBy: string
  evidenceStatus: "材料支持" | "仅人工陈述" | "材料冲突" | "缺少支持"
}
```

HTTP（全部 Node runtime、私有 `no-store`、写请求同源校验、逐次重验项目权限；错误复用 `BusinessError` 固定消息）：

- `GET /api/projects/[id]/facts?contractId=`：读权限；返回 `{facts: ProjectFactVersion[]}`（每个 factId 最新版本，按 field/factId 排序）。
- `GET /api/projects/[id]/facts/[factId]`：读权限；返回 `{versions: ProjectFactVersion[]}`（降序）；跨项目/未知 factId 统一 404。
- `POST /api/projects/[id]/facts`：仅管理员/可编辑成员；body 固定 `{operationId, factId?, baseVersionId, reason, value: ProjectFactDraft}`。
  - `baseVersionId` 首次保存为 `""`；人工更正必须等于该 factId 当前最新版本 id，否则 409 `CONFLICT`。
  - 服务端重新读取项目材料版本/解析快照/来源片段：材料必须 active 且处理授权、快照属于该材料版本、`materialVersionId` 与快照一致、片段属于该快照、`quote` 逐字存在于片段文本（允许规范空白归一化）；任一失败 422 `INVALID_SOURCE`。
  - 服务端设置 `projectId/createdBy/version/factVersionId/supersedesVersionId/sha256/createdAt/evidenceStatus`；浏览器不得提交这些字段。
  - 幂等：同 `operationId` 同内容返回同版本；不同内容 409。并发保存用事实版本链乐观检查（条件更新/唯一约束，断言恰好一行）。
  - 响应 `{fact: ProjectFactVersion}`。
- 事实保存不写成果表，不触发模型；确认状态不清除冲突（沿用领域校验器规则）。

**`fact-candidates` 机器成果**（Agent A 实现执行器 + 校验器，Lead 注册）：

```ts
type FactCandidatesValue = {
  schemaVersion: 1
  cutoff?: string
  materials: Array<{ materialId: string; materialVersionId: string; snapshotId: string; sha256: string; title: string }>
  complete: boolean
  candidates: Array<{
    candidateId: string
    field: string
    subject?: string
    nature: "材料记载" | "人工陈述" | "拟约定"
    originalValue?: string
    candidates?: string[]
    unit?: string
    caliber?: string
    occurredAt?: string; periodStart?: string; periodEnd?: string
    sources: Array<{ snapshotId: string; fragmentId: string; quote: string; locator?: string }>
  }>
  rejected: Array<{ quote?: string; reason: string; detail?: string }>
  warnings: string[]
}
```

- 执行器：`registerTaskExecutor("document-analysis", ...)` 在 `src/server/facts/runtime.ts` 显式注册（`startFactsRuntime()`，`instrumentation.ts` 在 lifecycle ready 后、任务 runner 之前调用）；加载所选材料（复用 A4c 模式：归属/状态/保留期/摘要/对象字节逐项复核），构建段落与片段映射，模型只提交候选结构；服务端逐条校验引文（逐字存在于片段），无效候选进入 `rejected`，不得进入 `candidates`；成功后以 machine 方式保存 `fact-candidates` 成果（`sources` 为全部候选来源，便于通用来源校验复用）；`partial` 用于存在 rejected/覆盖不完整，`failed` 用于无有效候选或调用失败；预算经 `context.reserveCall` 预留，撤权/到期在任何模型外发前失败。
- 校验器：只做 value 结构/必填/词表/候选清单与材料清单一致（纯函数，无法访问数据库）；候选引文与项目片段的逐字/归属校验由执行器在保存前完成，保存的 `sources` 再由 ResultService 通用来源校验兜底；未知 kind 仍 503。
- 只读约束在服务端强制：Lead 在 `ResultService`/access 增加 `noReviewKinds={fact-candidates}`，通用 `/results/[resultId]/review` 对其返回 422/FORBIDDEN；该 kind 无导出模板（导出 503）、不加入 serverOwnedKinds；UI 只作只读展示。

### 4.5 项目款项核对契约（Agent B 实现，接口冻结）

成果 kind `payment-reconciliation`，唯一写入路径为 `src/server/payments/service.ts` 的受控保存。服务必须复用生产实例：`paymentsHttpServices()` 取 `await resultHttpServices()` 的 `service`（已带生产校验器、machineOnly/serverOwned/existingOnly/noReview 集合，参照 `src/server/exports/access.ts` 复用 results 的做法），不得自建无集合的 `ResultService`；调用签名为 `saveResultRevision(identity, authorize, input, undefined, { serverOwned: true })`（第 4 参数是 machine 产物，款项无 machine 产物）。浏览器不能通过通用 `/results` 写入。

```ts
type PaymentReconciliationValue = {
  schemaVersion: 1
  cutoff: string
  contractId?: string
  rows: Array<{
    rowId: string
    nature: "计量" | "计付基数" | "净应付" | "付款" | "扣项" | "未到期" | "争议" | "材料余额"
    amountFen: string // 整数分字符串，^-?(0|[1-9]\d*)$
    taxBasis: "含税" | "不含税" | "不明"
    basis: "本期" | "累计" | "不明"
    periodStart?: string; periodEnd?: string; eventDate?: string; dueDate?: string
    conditionMet?: boolean; ratio?: string; payer?: string; payee?: string
    confirmation: "未确认" | "已确认" | "待核实"
    includedInNet?: boolean; note?: string
    source?: SourceAnchor
    factVersionIds?: string[]
  }>
  facts: Array<{ factId: string; factVersionId: string }>
  calculation: { netDueFen: string; paidFen: string; unpaidFen: string; formula: string } | null
  notes: string[]
  status: "conditional" | "draft"
}
```

HTTP：

- `POST /api/projects/[id]/payments`（新建）：body `{operationId, reason, value: {cutoff, contractId?, rows, facts}}`；edit 权限；服务端重验行结构与金额、来源片段、事实版本归属；调用 `calculateLedger` 生成 `calculation/notes` 与 `status`；`sources` = 所有行来源展平，`dependencies` = 事实 `{kind:"fact"}` + 行来源材料 `{kind:"material"}`；保存成功返回 `ResultView`。
- `POST /api/projects/[id]/payments/[resultId]/revisions`（修订）：body 增加 `baseVersionId`；服务端读取当前版本校验后另存新版本；基础版本过期 409；每次保存重跑确定性校验并恢复整份待复核。
- 读取/校验/复核/导出复用现有 `/results`、`/results/[resultId]/validate|review|exports` 路径；浏览器只能读已保存版本。
- 事实只读 seam（W0 冻结，Agent A 必须保持签名）：`FactRepository.version(projectId, factVersionId)` 与 `listLatest(projectId, contractId?)` 继续可用；B3a 只读调用它们校验事实存在/归属/摘要，跨项目返回 `FACT_NOT_FOUND` 统一映射 422/404，不直接查表。
- 校验器（纯函数）：schema/行校验/整数分/期次与税口径/到期条件；用 `calculateLedger` 重算并与 value 内嵌 `calculation/notes` 完全一致，不一致即 invalid；引文由通用来源校验（逐字）兜底；未知字段或结构不符 invalid。
- **ResultValidation 状态映射（冻结）**：`calculation !== null` 且结构/来源通过 → `valid`（仍须人工复核才能批准）；`calculation === null`（草案）→ `partial` 且带 `PAYMENT_DRAFT` issue，可保存、可草稿导出，**不能批准**（`reviewResult` 仅在 valid 时允许 approved）；结构/计算/来源违规 → `invalid`。
- 导出模板 `payment-reconciliation-v1`（`src/server/payments/export-template.ts`，Lead 注册到生产模板表）：标题、截止日、合同、逐行性质/金额/口径/到期/确认/来源定位、计算式与说明、`conditional/draft` 状态、确定性计算声明（不调用模型、不代表债权成立）；`blocksInvalidResult: true`。
- 服务端守卫：无效来源、事实版本不存在/跨项目、计算不一致、只读成员、跨项目 resultId 一律拒绝；保存不覆盖旧版本。

### 4.6 B2b 合同审查成果人工修订契约（Agent C 实现，接口冻结）

- 访问控制与机器字段保护（Lead）：`contract-review` 从 `machineOnlyKinds` 移出；`ResultService` 新增 `existingOnlyKinds` 选项（`{contract-review}`）：非机器保存必须携带已存在 `resultId`，禁止编辑器新建合同审查成果。保存时服务端加载该 result 当前版本：1) 去掉 `findingDecisions` 后的 value 与上一版本同投影做 canonical JSON 全等比较，任一机器字段（findings 的 ruleId/category/quote/citations/paragraphIndex、coverage、input、status、rejected/notLocated、warnings 等）变化即 422；2) `sources/dependencies/machineOutput/provenance` 一律由服务端从上一版本复制，浏览器提交值必须为空或完全一致，否则拒绝；3) 仅允许 `findingDecisions` 变化。测试覆盖改写 finding kind/quote/coverage/status/paragraphs/sources、删除发现、伪造无风险结论全部拒绝，仅 decisions 通过，旧版本无 decisions 兼容。
- 类型位置（Lead 冻结）：`FindingDecision` 定义在 `src/lib/business/contracts.ts`，供 `reviews/registry.ts`、报告模板与 UI 共用；不修改 `tools/contract-review/src/types.ts`（机器类型保持原样，`ReviewResult` 仍是机器输出，人工作为扩展字段在 value 层校验）。
- 值扩展：在机器 `ReviewResult` 基础上增加可选

```ts
type FindingDecision = {
  findingIndex: number
  ruleId: string
  decision: "采纳" | "驳回" | "修订"
  reason: string            // 1—500 字
  editedSuggestion?: string // 仅“修订”，1—2000 字
  editedImpact?: string     // 可选，1—500 字
}
```

`value.findingDecisions?: FindingDecision[]`；机器字段（findings 的 ruleId/category/quote/citations、coverage、input、status 等）不得由修订改写，人工值只出现在 `findingDecisions`。校验器：结构、index 有效且不重复、ruleId 与对应 finding 一致、枚举/字数、至少一项决定或与上一版本不同；其余沿用机器成果校验（引文由通用来源校验兜底）。旧机器版本无该字段仍校验通过（向后兼容）。
- 导出模板升级：Agent C 在 `src/server/reviews/export-template.ts` 提供 `contractReviewReportTemplateV2`（`contract-review-report-v2`，版本号提升，含处理决定/理由/修订建议行）；Lead 在 `exports/template.ts` 注册 v2 并保留 v1 只读历史（旧导出文件字节不变，新导出记录模板版本；依据 §8.2.1 “模板升级创建新导出，不改旧字节”）。
- UI/客户端（Agent C）：`reviews-client.ts` 增加 `saveResultRevision({resultId, baseVersionId, operationId, reason, value})`（复用 `/api/projects/[id]/results/[resultId]/revisions`）；审查工作区的发现项增加处理下拉、理由输入、修订建议输入；“保存修订版本”后重新校验、复核（旧复核不继承）、导出所选版本；只读成员不可保存；冲突 409 显示真实错误并保留编辑。

### 4.7 共享文件与注册（Lead 在 I1 修改）

| 文件 | 变更 |
| --- | --- |
| `src/server/results/registry.ts` | 注册 `fact-candidates`、`payment-reconciliation` 校验器（来自 A/B 模块） |
| `src/server/results/access.ts` | `machineOnlyKinds`：`contract-review` 移出，加入 `fact-candidates`、`payment-reconciliation`；`serverOwnedKinds` 加入 `payment-reconciliation`；新增 `existingOnlyKinds={contract-review}`、`noReviewKinds={fact-candidates}` 传参 |
| `src/server/results/service.ts` | 实现 `existingOnlyKinds`（机器字段不可变投影 + 服务端复制 sources/dependencies + 只允许 findingDecisions 变化）与 `noReviewKinds`；补 `results/service.test.ts`、`results/registry.test.ts`、`results/http.test.ts` 断言 |
| `src/server/results/http.test.ts` | 三条 HTTP 旁路回归：浏览器 POST 新 `contract-review`（无 resultId）403/422；带 resultId 的修订 body 出现 `machine/serverOwned/options` 等键 400；仅 `findingDecisions` 变化的修订可通过 |
| `src/server/exports/template.ts` | 注册 `payment-reconciliation-v1`；合同审查注册 `contract-review-report-v2`（引用 Agent C `reviews/export-template.ts`），历史 v1 导出不变；更新 `exports/template.test.ts` |
| `src/server/tasks/catalog.ts` + `catalog.test.ts` + `test-fixtures.ts` + `repository.test.ts` + `budget.test.ts` + `estimates.test.ts` | §4.3（catalog 4→5、document-analysis refs、受影响夹具与断言） |
| `src/server/database/migrations.ts` + `migrations.test.ts` | 0014 DDL + checksum 冻结 |
| `src/instrumentation.ts` | 后台链新增 `startFactsRuntime()`（注册事实准备执行器），位于 lifecycle ready 后、`startTaskRunner()` 前 |
| `src/server/projects/{lifecycle-schema.ts,reclamation.test.ts}` | C7 覆盖常量移除运行时 facts 表；测试用迁移建库、seed 事实行并断言按项目删除 |
| `src/server/document-agent/{projection.ts,projection.test.ts}` | 0014 兼容（显式 legacy operationId；语义不变，不接生产） |
| `src/lib/facts/types.ts`、`src/lib/payments/types.ts`、`src/lib/business/contracts.ts` | 共享类型/DTO 冻结（含 `SourceAnchor`、`ProjectFactDraft/Version`、`FindingDecision`、款项 DTO） |
| `src/server/verification-fields.ts` | 若 `quotesMatch`/引文归一化未导出则抽取为共享 helper，供 facts/b2b/来源校验复用 |
| `src/components/business/platform/project-business-workspace.tsx` | 业务选择增加「款项核对」，渲染组合壳 |
| `src/components/business/platform/project-payments-workspace.tsx`（新） | 组合 `ProjectFactsPanel` + `ProjectPaymentsPanel`，官方 Tabs（[docs/components/radix/tabs](https://ui.shadcn.com/docs/components/radix/tabs)） |
| `scripts/verify-round-seven-browser.mts`、`package.json` | 浏览器验收脚本与 `verify:r7` 入口 |
| `docs/reviews/2026-10-30-round-seven-*.md`、任务板 | 证据与状态，I1 收口 |

### 4.8 UI 冻结接口与官方组件

两个面板的 props 冻结为（同名类型均从各自面板文件导出；组合壳按此接线）：

```ts
type PanelProps = {
  project: ProjectSummary
  active: boolean
  canEdit: boolean
  blocked: boolean
  isCurrent: () => boolean
  onAccessInvalid: (failure: unknown) => void
  registry: UnsavedRegistry
}
type FactsPanelProps = PanelProps
type PaymentsPanelProps = PanelProps
```

- `ProjectFactsPanel` / `ProjectPaymentsPanel` 各自实现空状态、加载、错误、只读与撤权；脏数据通过 `registry.register({id,label,save,discard})` 接入统一未保存保护（事实：`fact:<factId>`；款项表：`payment:<resultId|new>`）。
- 组件按官方 shadcn/ui 模式组合：Tabs（[radix tabs](https://ui.shadcn.com/docs/components/radix/tabs)）、Table（[table](https://ui.shadcn.com/docs/components/table)）、Card（[card](https://ui.shadcn.com/docs/components/card)）、Dialog（[dialog](https://ui.shadcn.com/docs/components/dialog)）、Sheet（[sheet](https://ui.shadcn.com/docs/components/sheet)）、Input/Label/Textarea（[input](https://ui.shadcn.com/docs/components/input)、[label](https://ui.shadcn.com/docs/components/label)、[textarea](https://ui.shadcn.com/docs/components/textarea)）、Select（[select](https://ui.shadcn.com/docs/components/select)）、Button（[button](https://ui.shadcn.com/docs/components/button)）、Badge（[badge](https://ui.shadcn.com/docs/components/badge)）、Alert（[alert](https://ui.shadcn.com/docs/components/alert)）；正式实现时以实际读取的官方源码为准，并在变更说明记录所用 block/component URL 与任何必要偏离理由。禁止自定义 CSS/任意 Tailwind 值/自造颜色与阴影。
- 事实来源选择复用 `verification-fragment-picker.tsx` 的交互（材料→快照→片段），不复制其状态代码；只读成员隐藏写操作。

## 5. 工作包

### B1a（Agent A）

目标：项目事实从「准备任务候选」到「人工确认的不可变版本」全链路可用，且不具备项目权限的调用一律拒绝。

- [ ] 迁移后事实仓储：`FactRepository` 适配 0014 列（operation_id/request_hash/幂等/基础版本冲突断言一行）、读写摘要校验、跨项目过滤；测试改用迁移账本建表。
- [ ] `src/server/facts/service.ts`：保存/更正校验（项目材料版本→快照→片段→引文逐字归一化匹配；active/处理授权/保留期；factId 版本链乐观并发；服务端字段与 evidenceStatus 派生；人工更正理由；幂等）。
- [ ] `src/server/facts/{access,http}.ts` 与三条项目路由：身份/项目权限/读写角色/同源/请求体上限/错误映射；读含 viewer，写仅 admin/editor；跨项目统一 404。
- [ ] `src/server/facts/{input,runtime}.ts` + `document-analysis` 执行器：材料装载（复用 A4c 输入模式）、模型候选结构、逐条引文校验入 accepted/rejected、覆盖与状态、预算预留、撤权/到期外发前失败、machine 保存 `fact-candidates` 成果。
- [ ] `src/server/facts/result-validator.ts`：候选成果校验器（结构与词表、材料清单一致、候选引文包含于 sources、拒绝清单、状态一致）。
- [ ] `src/lib/business/facts-client.ts`：列表/历史/保存/准备任务提交/任务查询/候选成果读取；错误映射与撤权回调。
- [ ] `src/components/business/platform/project-facts-panel.tsx` 等：材料选择（已解析快照）、任务状态轮询（终态停止）、候选列表、确认/更正 Dialog、事实列表（冲突/待核实高亮）、历史、未保存保护、只读视图。
- [ ] 测试：仓储幂等/并发/跨项目/摘要篡改；服务引文不匹配、跨项目来源、过期材料、未授权、基础版本冲突；HTTP 权限/404/同源/超限；执行器假模型（有效/部分/全部无效/撤权/预算耗尽/令牌失效）；候选校验器正反例。
- 验收：定向测试通过、ESLint/tsc 定向通过；`document-analysis` 提交不再 503，任务产生真实 machine 候选成果；浏览器联验由 Lead 执行。

### B3a（Agent B）

目标：项目款项表可按人工核对保存为 `payment-reconciliation` 成果，计算确定、可重验/复核/导出，篡改与越权被拒绝。

- [ ] `src/server/payments/result-validator.ts`：value 结构/行/金额/口径/状态校验 + `calculateLedger` 重算比对（完全一致才 valid）；引文兜底；旧版本向后兼容。
- [ ] `src/server/payments/service.ts`：受控保存/修订（项目权限、来源与事实版本重验、事实跨项目拒绝、计算快照、sources/dependencies、幂等 operationId、基础版本冲突、serverOwned 写入）。
- [ ] `src/server/payments/{access,http}.ts` 与两条项目路由（新建/修订）：同源、no-store、请求体上限、错误映射；只读成员拒绝。
- [ ] `src/server/payments/export-template.ts`：`payment-reconciliation-v1` 报告正文（行、计算、状态、确定性声明），`blocksInvalidResult: true`。
- [ ] `src/lib/business/payments-client.ts`：读结果列表/详情、保存/修订、校验/复核/导出创建与下载；错误映射。
- [ ] `src/components/business/platform/project-payments-panel.tsx` 等：款项表行编辑（性质/金额/期次/税口径/到期/确认/去重/负值提示）、来源与事实引用、计算明细与待核实说明、保存/重验/复核/Word 导出、冲突处理、未保存保护、只读视图。
- [ ] 测试：1,000,000 计量 × 80% − 300,000 已付 = 500,000（不能用计量直接相减）；重复付款去重；负余额保留；未确认/口径不明/缺到期证据 → draft；篡改 calculation/status → invalid；跨项目来源/事实、只读、基础版本过期、导出 invalid 拦截。
- 验收：定向测试通过；保存→重验→复核→导出闭环（浏览器由 Lead 联验）。

### B2b（Agent C）

目标：已保存的合同审查机器成果可逐条处理并另存修订版本，重验后恢复待复核，导出报告显示处理决定。

- [ ] `src/server/reviews/registry.ts` 校验器扩展：`findingDecisions` 结构与业务校验（index/ruleId/枚举/字数/唯一），机器字段完整性，向后兼容旧版本。
- [ ] `src/server/reviews/export-template.ts`：`contractReviewReportTemplateV2`（`contract-review-report-v2`，含处理决定/理由/修订建议行），Lead 接线到 `exports/template.ts` 并保留 v1 历史导出。
- [ ] `src/lib/business/reviews-client.ts`：`saveResultRevision` 保存修订（sources/dependencies 沿用所选版本），错误映射与冲突处理。
- [ ] `project-review-workspace.tsx` / `review-result-panel.tsx` / `review-draft.ts` / `review-state.ts`：发现项处理编辑、保存修订版本、重验、复核（旧复核不继承）、导出、未保存保护；只读成员不可编辑保存。
- [ ] 测试：校验器正反例（重复 index、错 ruleId、空理由、超长、机器字段缺失）、客户端保存请求/错误、状态机（保存后待复核、旧版本复核拒绝）、导出正文含处理决定。
- 验收：定向测试通过；人工修订后重验/复核/导出闭环（浏览器由 Lead 联验）。

### I1（Lead）

- [ ] W0（先决）：确认并发写者已停止（§2），经用户授权后提交 A0（若并发工作流先自行提交，则按 §2 拆 A0a/A0b）、验证工作树干净、建立分支、重跑 `pnpm check/test` 记录实际数；完成规格 §4.1、0014、catalog、共享类型/DTO、任务板（team_task_create 7 项：W0/B1a/B3a/B2b/I1/Review + 收口）。并发写者门禁未通过前不执行任何提交、不写 spec/源码（计划文档除外）。
- [ ] 审核并合入 Agent 交付：按 B1a → B3a → B2b 顺序按路径提交；每包定向测试与 lint；共享注册表接线（§4.7）。
- [ ] C7 适配：迁移 0014 后 `reclamation.test.ts` 断言与注释；`pnpm test` 全量。
- [ ] 浏览器验收 `scripts/verify-round-seven-browser.mts`（playwright-core msedge，`APP_ORIGIN=http://127.0.0.1:3000`），先执行前置检查并在证据中记录，不满足时 fail 并标未运行，不伪造数据：
  - 启动 dev 服务后迁移自动应用到 0014、project lifecycle ready；记录 `APP_ORIGIN`、端口、数据库路径与迁移编号；`data/equilens.sqlite` 现仅 0001—0009，启动后应先补齐 0010—0014。
  - **B1a**：模型配置可用时真实调用一次事实准备任务并记录调用数/用量；不可用则浏览器只验证“人工陈述/拟约定事实保存 + 更正版本”，机器候选路径在证据中标“未运行（模型不可用）”。不预置候选成果、不调用测试夹具冒充机器结果。
  - **B2b**：需要已保存的 `contract-review` 机器成果。若库中不存在且模型不可用，浏览器只验证“读取已有成果（若存在）/只读受限路径”，B2b 浏览器路径标“未运行”；禁止用假成果替代。模型可用时经一次真实审查生成机器成果后再编辑修订。
  - **前置数据清单**（逐项记录“已满足/未运行”）：项目与成员；合成 DOCX 上传并解析成功；人工事实（模型不可用时）；款项行与来源；B2b 依赖的既有 `contract-review` 机器成果或真实模型生成记录；迁移已到 0014 且 lifecycle ready。
  - 流程：登录 123/123 → 项目 → 上传/解析合成 DOCX → 款项核对：事实（准备/手工）→ 候选确认保存事实 → 事实更正版本；款项表保存 → 计算 500,000.00 → 重验 → 复核 → Word 导出下载并记录 sha256；合同审查：逐条处理 → 保存修订 → 重验 → 复核 → 导出含处理决定；失败路径（未确认事实/引文不符/只读/冲突/篡改机器字段）单列。截图与下载保存 `.superpowers/round7/`。
- [ ] 门禁：`pnpm check`、`pnpm test`、`pnpm build`（Turbopack 若异常则记录并尝试 webpack 替代，不记为默认构建通过）、`pnpm smoke`、`git diff --check`；如实记录测试数与原始输出。
- [ ] 证据：`docs/reviews/2026-10-30-round-seven-integration.md`、各包记录、任务板；更新 `docs/reviews/2026-10-29-ac-final-acceptance.md` 不重写历史，本轮新增文件独立记录。
- [ ] 独立只读交叉审查（Review）→ 修复阻断项 → 最终提交；不推送、不部署、不建 Issue。

## 6. 合入顺序、门禁与证据

0. **执行前置**：并发写者已停止（§2 核对）；用户授权 A0（必要时 A0a/A0b）基线提交与 B 轮实施；两项未满足不开始任何写操作/提交。
1. W0（Lead）→ A0 提交 + 工作树干净 + `pnpm check`/`pnpm test` 基线重跑 → 规格/迁移/catalog/DTO 提交；创建共享任务。
2. B1a/B3a/B2b 三包并行（互不写同一文件）→ 各自定向测试与 ESLint/tsc → Lead 逐包审查后按路径提交。
3. 注册表/运行时/迁移适配（Lead）→ 全量 `pnpm check/test` → 浏览器验收脚本 → `pnpm build/smoke` → `git diff --check`。
4. 独立交叉审查（REVIEW → 修复 → 复验）→ 证据文档 → 最终提交。

门禁最低要求：四项命令 exit 0（构建异常按上方规则如实记录，不以替代构建冒充默认构建通过）；测试数、浏览器项数、真实模型调用次数与原始输出如实登记；无法执行的云/平台项保持外部缺项。

## 7. 不宣称与外部缺项

- 不宣称 B 线完成；B4/B5、四业务主线端到端与 B 线验收留第八轮。
- 不宣称 AC-06/07/19/20/22 整项通过：无 24/60 独立业务质量集、无领域核对签核、无真实 OBS/GaussDB/OCR/MaaS 定价与配额验证。
- 真实模型可用性/价格/额度未验证：事实准备任务只按实际调用记录，不推算容量；模型不可用即如实失败并保留缺项。
- 匿名文档 Agent 增量的款项/证据/催款函仍是匿名联调，不计入项目业务验收。
- 不宣称 `payment-reconciliation`/`evidence-organization`/`collection-letter` 任务类型已开放；本轮款项成果只走受控成果保存路径。
- 模板/规则领域签核、Microsoft Word 人工版式验收、Linux 容器与 GitHub CI 运行记录仍缺。

## 8. B 线后续（第八轮预告，不属本轮执行）

1. B4 项目证据整理：证据项/报告成果（`evidence-report` 或等价 kind）+ 时间线/争点/证据对应/缺证项 UI + Markdown/Word 导出；引用 B1a 事实版本与 B3a 款项成果。
2. B5 项目催款函：固定 `collection-letter-v1` 模板内容（乙方维护）+ 显式选择合同/款项/证据保存版本 + 拟发送计划 + 确定性渲染/复核/DOCX 导出，不自动外发。
3. 四业务主线端到端（合同审查 → 款项核对 → 证据整理 → 催款函）新输入演练与 Word 核对、B 线验收记录与 AC 对照、剩余外部缺项清单。
4. 若第八轮受外部条件阻断，保留明确缺项，不伪造验收。
