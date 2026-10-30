# EquiLens 第三轮并行实施计划（项目合同审查闭环）

> 执行说明：本文件是第三轮实施计划，沿用[总计划](2026-10-27-three-person-development-plan.md)与[第二轮计划](2026-10-29-round-two-plan.md)的工作包编号（A4c、B2a、I1）；不新增产品契约，不是完成记录，不自动创建 Issue、推送、部署或发布。
> 基线：`alaaladaka/round2/integration` @ `6abeaf3`（第二轮 A3c/A4a/A4b/C1b/C2a/C2b/C2c/C3 与两次收口修复已合入）。
> 本轮目标：让 A4 成果/导出离开"仅测试"状态，并交付第一个真实项目业务闭环——**项目合同审查**：项目材料 → 审查任务 → 可复核机器成果 → 人工复核 → 版本化 Word 导出。

## 1. 范围

**本轮交付（P0）**

| 包 | 所有者 | 内容 |
| --- | --- | --- |
| W0 | Lead | 规格与共享契约冻结、任务板、迁移复核 |
| A4c | Agent A | 项目 `contract-review` 任务执行器；`contract-review` 成果校验器与导出模板的生产注册；执行失败不伪造结果 |
| B2a | Agent B | 项目工作区「业务处理」：选择已解析材料、提交/跟踪审查任务、查看报告、成果校验/人工复核、Word 导出下载 |
| I1 | Lead | 集成、跨包审查、check/test/build/smoke、浏览器验收、证据与提交 |

**明确不在本轮**

- 成果人工逐条修订（findings 编辑与另存）→ B2b；本轮只做机器成果的校验、批准/驳回与导出。
- B1a/B3a 事实/款项项目接线、B3 款项 UI、B4 证据、B5 催款函 → 后续轮次；迁移 0010/0011 保持预留，不注册。
- C4 OCR/投标核验、C5 两模板、C6 知识发布 UI、C7 生命周期与完整恢复。
- 真实 OBS/GaussDB/OCR 与领域规则签核；规则仍为待核对内置包，审查结果必须显示"依据未签核、需人工复核"。

## 2. 分支与写作用域

共享工作目录，不并行 checkout。集成分支：`alaaladaka/round3/review`（从 `6abeaf3` 建立）。

| 所有者 | 独占写作用域 |
| --- | --- |
| Agent A | `src/server/reviews/**`、`src/server/results/registry.ts`、`src/server/exports/template.ts`、`src/server/results/access.ts`、`src/server/exports/access.ts`、`src/server/tasks/executors.ts`（仅注册处）、相关测试 |
| Agent B | `src/lib/business/reviews-client.ts`、`src/lib/business/reviews-*.test.ts`、`src/components/business/platform/project-review-*.tsx`、`src/components/business/platform/review-*.ts(x)`、`src/components/business/platform/project-documents-workspace.tsx`、相关测试 |
| Lead | `spec/**`、`src/lib/business/contracts.ts`、`src/server/tasks/catalog.ts`、`src/instrumentation.ts`、`package.json`、`src/server/database/migrations*`、证据、最终合并提交 |

共享文件只能由 Lead 修改；Agent 需要改动共享文件时先通知 Lead。

## 3. W0 冻结接口

### 3.1 任务提交（Lead 冻结，A/B 消费）

`src/server/tasks/catalog.ts` 中 `contract-review` 定义调整为：

```ts
"contract-review": {
  maxCalls: 25, maxCostFen: 3000,
  refs: z.object({ materials: materialRefs }).strict(),   // 1—10 个已提交材料版本
  conditions: z.object({
    asOf: day.optional(),
    scene: z.enum(["auto", "mep-sub-2026", "decoration-sub-2026", "curtain-wall-sub-2026", "steel-structure-sub-2026"]),
    role: z.literal("专业分包人"),
    region: z.string().trim().min(1).max(100),
    externalProcessingConsent: z.literal(true),
    unreviewedMaterialsConsent: z.boolean(),
  }).strict(),
}
```

- 浏览器只提交 `kind`、`projectId`、`refs`、`conditions`；不提交模型、价格、预算、manifest。
- `POST /api/tasks`（Idempotency-Key）语义不变：先鉴权、按 kind 固定 schema 构建 manifest、去重、入库；执行器未注册时不入库并返回 503。
- 任务引用只允许已提交且解析成功的项目材料版本；执行器再次核对归属与摘要，不信任提交时快照。

### 3.2 执行器（Agent A 实现）

- 唯一注册入口：`src/server/reviews/runtime.ts` 的 `startReviewRuntime()`，在 `src/instrumentation.ts` 中先于 `startTaskRunner()` 调用（与 `startMaterialRuntime` 并列），显式 Node 生命周期内注册，禁止导入时启动。
- 依赖注入：

```ts
export type ProjectReviewRunner = (input: {
  paragraphs: Array<{ index: number; text: string; location: string }>
  complete: boolean
  documentTitle: string
  documentVersionId: string
  parseSnapshotId: string
  textSha256: string
  context: { scene: string; role: "专业分包人"; region: string }
  maxCalls: number
  signal: AbortSignal
  env: Record<string, string | undefined>
  onBeforeCall(reservation: { callNumber: number }): Promise<void>
  onExchange(exchange: unknown): Promise<void>
}) => Promise<unknown>   // tools/contract-review 的 ReviewResult
```

生产注入使用现有 `reviewWithAgent`（单 Agent 有界流程，`mode:"debug"`，从内置规则包加载，服务端模型配置），测试注入确定性假实现；执行器不得把一个演示结果当作模型结果。
- 执行步骤：`refreshAccess` 后加载每个材料版本→对象字节→sha256→最新解析快照与片段；项目/材料保留期与状态复核；构建段落（DOCX 用快照段落位置，PDF 用页码位置；覆盖不完整时 `complete=false`）；预算在每次模型调用前 `context.reserveCall`，由 `onBeforeCall` 触发；报告→成果、任务取 `callsUsed` 预算；任一步失败任务终态 `failed` 并保留可判定错误码。
- 撤权、账号禁用、项目/材料删除、保留期到期必须在任何模型外发前失败；续期检查覆盖每个阶段。

### 3.3 成果与导出（Agent A 实现，Lead 注册）

- 成果 `kind = "contract-review"`，`value` 为现有 `ReviewResult`（`schemaVersion: 1`），不新增平行报告结构。
- 校验器 `src/server/results/registry.ts` 提供生产注册表：
  - 结构与必填：`schemaVersion/status/input.textSha256/input.parseSnapshotId/coverage/findings/errors`。
  - 来源：把 findings 中每处引文映射为 `{fragmentId, snapshotId, quote}`；引文必须逐字出现在对应项目片段；任何无效引用使校验 `invalid`，禁止批准。
  - 覆盖：`input.complete=false` 或 coverage 未覆盖类别时不得输出"无风险"；`status` 与覆盖不一致按 invalid 处理。
  - 结果保留 `mode/warnings/errors`，导出与 UI 显示"依据未签核、需人工复核"。
- 导出模板 `src/server/exports/template.ts`：`contract-review-report-v1`，输出 AI 标识、成果/版本、校验与复核状态、模板/渲染版本、报告摘要与逐条发现（含位置与依据）；只从所选不可变版本渲染，无模型调用。
- `results/access.ts` 与 `exports/access.ts` 使用生产注册表；未注册类型继续 503。A4a/A4b 的测试夹具不得进入生产注册表。

### 3.4 HTTP 与 UI 契约（B2a 消费，已有路由，不新增）

- 任务：`POST /api/tasks`、`GET /api/tasks?projectId=`、`GET /api/tasks/[id]`。
- 成果：`GET/POST /api/projects/[id]/results`、`GET /results/[resultId]`、`POST .../validate`、`POST .../review`。
- 导出：`GET/POST .../exports`、`GET .../exports/[exportId]/content`。
- 材料：`GET /api/projects/[id]/materials`（含解析状态、快照、覆盖）；只有已解析快照可用于审查。
- UI：项目工作区新增「业务处理」页签（文档 / 业务处理 / 规范库），只读成员可看任务与成果但不能提交/复核/导出。

### 3.5 迁移

本轮不新增业务迁移；0005 任务、0006/0008 材料与快照、0007 成果/导出表已覆盖。不得改写 0001—0009，0010/0011 保持预留。

## 4. 工作包

### A4c（Agent A）

**目标：** 提交一次项目审查任务即产生真实、可校验、可复核、可导出的机器成果。

- [ ] `src/server/reviews/input.ts`：材料版本→快照→段落/位置/来源映射；拒绝缺失对象、摘要不符、已删除/过期/未授权材料。
- [ ] `src/server/reviews/executor.ts`：执行器（依赖注入、权限复核、预算预留、成果机器写入、任务终态）；撤权/过期/预算失败前不调用模型。
- [ ] `src/server/reviews/registry.ts`：`contract-review` 成果校验器（结构、来源逐字、覆盖与状态一致、未签核标记）与报告导出模板。
- [ ] `src/server/reviews/runtime.ts`：`startReviewRuntime()` 注册执行器；`src/instrumentation.ts` 接入。
- [ ] `src/server/results/access.ts`、`src/server/exports/access.ts`：生产注册表接线。
- [ ] 测试：假 review runner + SQLite/合成存储覆盖成功、部分覆盖、来源非法、撤权不调用模型、保留期到期、预算预留失败、任务令牌失效、机器成果不可覆盖人工版本；未注册 kind 仍 503。

**验收：** 定向测试通过；`pnpm exec tsc --noEmit`、`pnpm exec eslint` 定向通过；提交 A4c 证据到 `docs/reviews/`。

### B2a（Agent B）

**目标：** 项目工作区完成"选择材料→提交审查→跟踪→报告→校验→复核→导出"闭环 v1。

- [ ] `src/lib/business/reviews-client.ts`：任务提交/查询、成果读取/校验/复核、导出创建/列表/下载；查询串与错误码与现有 HTTP 契约一致，只读成员不提交写请求。
- [ ] `src/components/business/platform/project-review-workspace.tsx`：材料选择（仅解析快照可用）、审查选项（场景 auto/固定、地域）、外发与未签核确认、提交与任务状态轮询（运行中 5 秒，终态停止）。
- [ ] 报告展示复用现有 `contract-review-report.tsx` 的展示约定；明确显示覆盖、未完成、未签核依据和"不代表无风险"。
- [ ] 成果操作：重验、批准/驳回（写 review）、创建并下载 Word；冲突、撤权、503 显示真实错误，不自动重试外发。
- [ ] 只读成员只读；项目/工作区切换先保存未保存对象，迟到响应不进入新项目。
- [ ] 测试：client 请求/错误映射、任务状态机与轮询停止、只读与撤权、导出失败提示；组件生命周期以纯逻辑测试覆盖。

**验收：** 定向测试与 lint 通过；B2a 证据记录；浏览器联验由 Lead 执行。

### I1（Lead）

- [ ] W0：spec/01 §8.2.2、§9.2 与 spec/02「业务处理」入口更新；冻结 catalog 与 contracts。
- [ ] 分支建立、共享任务板、跨包接口核对。
- [ ] 合入顺序：A4c → B2a；每包独立提交并在合入前运行定向检查。
- [ ] 全量 `pnpm check`、`pnpm test`、`pnpm build`、`pnpm smoke`、`git diff --check`。
- [ ] 浏览器验收：合成项目上传 DOCX→解析→业务处理→提交审查→任务状态→报告→校验→复核→导出→下载；记录字节摘要；失败路径（无效引用、撤权、导出失败）单列。
- [ ] 真实模型调用：仅在配置可用时发起一次合成资料审查，记录调用与用量；不可用则保留外部缺项，不伪造结果。
- [ ] 证据：`docs/reviews/2026-10-29-round-three-integration.md` 及各包记录；不推送、不部署、不建 Issue。

## 5. 门禁与证据

- 工程门禁：`pnpm check` / `pnpm test` / `pnpm build` / `pnpm smoke` / `git diff --check` 全部 exit 0；测试数如实记录。
- 浏览器门禁：主闭环与失败路径截图；真实模型调用量与原始输出保存到忽略目录。
- 明确不宣称：AC-03/17/22 整项通过（规则未签核、无领域验收）、真实 OBS/GaussDB/OCR、完整恢复、法律质量集。

## 6. 外部缺项

- 内置规则未签核 → 审查结果必须带未签核/人工复核标记，不得作为正式法律结论。
- 真实 OBS 未接入 → 项目材料/导出仍使用开发合成存储联调，生产 fail-closed。
- 真实模型可用性/价格/额度未验证 → 只按一次实际调用记录，不推算容量。
- GaussDB/OCR/容器/Linux 恢复未验证。
