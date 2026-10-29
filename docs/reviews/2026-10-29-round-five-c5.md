# 第五轮 C5 项目文书起草验证（模板目录、拟约定输入、确定性填充、草稿导出）

日期：2026-10-29。阶段：第五轮 P0 业务包 C5（Agent D）。基线：`alaaladaka/round5/business` @ `04f8c40`。
本记录只写实际执行过的检查；未运行项单列，不宣称 AC-05/AC-21 整项、法律质量或真实 Word 版式验收。

## 交付范围

- 代码版本化模板目录（`src/server/templates/catalog.ts`）：`specialty-subcontract-v1`、`supplementary-agreement-v1`，固定 id/version/sha256、章节与条款、必填与条件必填字段、标签、来源门槛；模板状态固定“待核对”，不建模板发布表，不伪装签核。
- 迁移 0012 schema（`src/server/templates/schema.ts`，DDL 与计划 §3 一致）：`equilens_drafting_inputs`、`equilens_drafting_input_versions`（`UNIQUE(project_id, operation_id)`）。**由 Lead 在集成时注册并冻结 checksum；本轮我未改 `migrations.ts`。**
- 拟约定输入不可变版本仓储与服务（`src/server/templates/repository.ts`、`src/server/drafting/{payload,service}.ts`）：operationId 幂等、同 operationId 不同输入 409、过期 baseVersionId 409、跨项目读取 404、版本单调且旧版本只读。
- 确定性渲染（`src/server/drafting/render.ts`）：纯函数（模板 + 已保存字段 + 固定原合同引用），缺失字段渲染为 `【待补充：标签】`，不补造主体/证号/金额/日期/条款号；条件字段/条款仅在条件命中时参与；同输入逐字一致；只做字段重渲染，不接受浏览器正文/章节编辑。
- 补充协议原合同归属：仅接受本项目活跃材料版本或本项目已保存 `specialty-subcontract` 成果版本；缺失、跨项目、类型不符、材料停用/过期均在保存前拒绝。
- 成果写入（`src/server/drafting/service.ts`）：经生产 `ResultService.saveResultRevision(..., { serverOwned: true })` 写入 `specialty-subcontract`/`supplementary-agreement` 人工成果；value 内嵌模板 id/version/sha/status、拟约定输入版本与摘要、字段、缺失清单、渲染正文、`TEMPLATE_UNREVIEWED` 警告、原合同 pin；状态固定 `partial`，不可批准为完整复核成果。
- 校验器（`src/server/drafting/validation.ts`）：`specialtySubcontractValidator`、`supplementaryAgreementValidator`；结构/必填/条件必填/模板 sha/十进制金额/输入摘要/缺失清单一致/**重渲染逐字一致**/原合同归属；模板“待核对”决定结果只能是 `partial`，本轮不存在 `valid` C5 成果；任何不一致为 `invalid`。**由 Lead 注册到 `results/registry.ts`。**
- 导出模板（`src/server/drafting/export-template.ts`）：`specialty-subcontract-v1`、`supplementary-agreement-v1`，只读结果 value，输出 AI/人工来源说明、模板/输入/原合同 pin、缺失清单、未核对声明；`blocksInvalidResult: true`，partial 草稿可导出、invalid 禁止。**由 Lead 注册到 `exports/template.ts`。**
- HTTP（`src/server/drafting/{http,access}.ts` + `src/app/api/projects/[id]/{drafting-inputs,drafts}/**`）：`GET/POST /drafting-inputs`、`GET /drafting-inputs/[inputId]`、`POST /drafts`、`POST /drafts/[resultId]/revisions`；Node runtime、私有 no-store、同源写、路径项目逐次授权、未知/跨项目统一 404、只读 403、请求体白名单（拒绝 `sources/dependencies/paragraphs/value/kind/template/projectId` 等），256 KiB 上限。
- 客户端与工作区：`src/lib/business/drafting-client.ts`、`src/components/business/platform/project-drafting-workspace.tsx`（`ProjectDraftingWorkspace`，props 对齐 `ProjectReviewWorkspace`）与纯逻辑 `drafting-form.ts`；保存拟约定输入与生成草稿分两步、条件必填展示、来源标签、缺失项、重验、复核仅“驳回/退回修改”、草稿 Word 创建/下载、旧导出下载、只读成员禁写、dirty 表单登记 `UnsavedRegistry`、迟到响应隔离、空状态只命名缺失资源。

## 实际执行命令与结果（本地 Windows / Node.js 24.14.1 / SQLite 合成库）

| 命令 | 实际结果 |
| --- | --- |
| `pnpm exec tsx --test src/server/templates/*.test.ts src/server/drafting/*.test.ts src/lib/business/drafting-client.test.ts src/components/business/platform/drafting-form.test.ts` | exit 0，43 tests / 43 pass / 0 fail |
| `pnpm exec eslint src/server/templates src/server/drafting src/lib/business/drafting-client.ts src/lib/business/drafting-client.test.ts src/components/business/platform/drafting-form.ts src/components/business/platform/drafting-form.test.ts src/components/business/platform/project-drafting-workspace.tsx "src/app/api/projects/[id]/drafting-inputs" "src/app/api/projects/[id]/drafts"` | exit 0，无输出 |
| `pnpm exec tsc --noEmit`（仅按本包路径过滤 C5 文件） | C5 文件 0 错误；整仓 tsc 当时包含其它并行包（`src/server/knowledge/publication.ts`、`src/server/reviews/runner.ts`）尚未完成的类型错误，非本包改动，集成时以 Lead 全量结果为准 |

定向测试分布：模板目录 5、渲染 7、输入/生成/修订/写路径 9、校验/矩阵/导出 7、HTTP 4、client 4、工作区纯逻辑 7（共 43）。

## 明确未运行 / 未交付

- 未运行 `pnpm check` / `pnpm test` / `pnpm build` / `pnpm smoke` / 浏览器验收（按任务约定只跑定向 tsx 测试、定向 eslint 与 tsc；浏览器验收由 Lead 执行）。
- 未注册迁移 0012、未接线两个校验器/两个导出模板、未改 `package.json` 测试路径、未挂载业务宿主：均为 Lead 集成工作；本包提供 `statements`、`specialtySubcontractValidator`、`supplementaryAgreementValidator`、`specialtySubcontractExportTemplate`、`supplementaryAgreementExportTemplate` 导出。
- 正文/章节人工编辑、催款函内容未交付（按计划属后续/C5 范围外，催款函属 B 线）。
- 无真实模板法律核对/签核；模板固定“待核对”，C5 草稿始终 partial，`valid` 分支本轮不可达。
- 未做真实 Word 版式验收（仅用生产 `renderDocx` 渲染并解包检查文本），未验证 GaussDB/真实 OBS/大文件性能。
- 未做 4 例文书封存评测、24 例 Demo 业务集与法律质量评估。

## 关键约束与风险

- 模板 sha 由模板定义（含条款文案）计算；集成冻结后若再改 `src/server/templates/catalog.ts`，旧成果会因模板 sha 不一致而校验失效。模板升级应按“新增版本 + 新导出”执行，不得原地改 v1。
- `valid` 状态本轮结构性不可达（模板固定待核对）；任何把 C5 草稿批准为完整复核成果的路径都应被服务端拒绝。将来模板签核后需重新设计状态与批准策略。
- 补充协议若以 `specialty-subcontract` 成果为原合同，导出保留期只取项目期限与依赖中的材料期限（当前 C5 成果无材料来源），不额外传播原成果的依赖链；原成果本身仍可追溯（value 内嵌引用与 dependency）。
- 拟约定输入列表无分页（按项目用量；计划未要求），UI 在项目切换/权限暂停后拒绝迟到响应。
- 浏览器交互、取消/切换保护与真实下载仅由 Lead 的浏览器验收覆盖。

## 代码位置

- 模板：`src/server/templates/{catalog,schema,repository}.ts`（+ `catalog.test.ts`）。
- 起草：`src/server/drafting/{payload,render,value,validation,export-template,service,http,access}.ts`、`drafting-test-fixtures.ts`（+ `render.test.ts`、`service.test.ts`、`validation.test.ts`、`http.test.ts`）。
- 客户端/界面：`src/lib/business/drafting-client.ts`（+ test）、`src/components/business/platform/{drafting-form.ts,drafting-form.test.ts,project-drafting-workspace.tsx}`。
- 路由：`src/app/api/projects/[id]/drafting-inputs/{route.ts,[inputId]/route.ts}`、`src/app/api/projects/[id]/drafts/{route.ts,[resultId]/revisions/route.ts}`。
