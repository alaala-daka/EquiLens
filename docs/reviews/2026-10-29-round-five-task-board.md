# 第五轮共享任务板（C4 界面 / C6 知识发布 / C5 文书起草）

基线 `alaaladaka/round4/verification` @ `7867daf`；集成分支 `alaaladaka/round5/business`（W0 提交 `04f8c40`）。
计划：[第五轮计划](../superpowers/plans/2026-10-29-round-five-plan.md)（执行前经独立审查，先 REVISE 后 CONFIRMED；审查报告在忽略目录 `.superpowers/round5/plan-review.md`）。
本文件记录执行状态，不表示验收通过；状态只按实际命令/测试/证据更新。

## 工作包状态

| 包 | 主写者 | 范围 | 前置 | 状态 |
| --- | --- | --- | --- | --- |
| W0 | Lead | 规格（§4.4/§7.1/§8.2.2/§8.2.4/§9.1、spec/02 §5.1、spec/04 0011/0012）、`TaskManifest.publications` 与三态解析器、ResultService 文书集合、材料片段读取、计划 | 基线 | 已提交 `04f8c40`（`pnpm check` 0；catalog/materials 定向测试通过） |
| C4-UI | Agent B | verifications-client、核验工作区、片段选择、字段/外部记录/比较/结果/导出、只读与切换保护 | W0 | 已提交 `529414a`；浏览器验收发现混合任务列表缺陷并在后续修复（过滤 C4 kind，35/35 测试）；浏览器 11/11 通过 |
| C6 | Agent C | 0011 发布仓储、状态机/假签核、私有 CLI、三态解析器、published 校验与运行时固定 | W0 | 已提交 `7c6904a`（定向 77/77＋tools 13＋相邻 40；合成夹具，无真实发布） |
| C5 | Agent D | 模板目录、0012 拟约定输入、确定性渲染、server-owned 成果、两个导出模板、起草工作区 | W0 | 已提交 `d92244b`（定向 43/43；模板固定“待核对”，只产生 partial 草稿；无正文编辑/催款函） |
| I1 | Lead | 迁移注册、注册表/导出/宿主接线、门禁、浏览器验收、证据、提交 | B/C/D | 已完成：`pnpm check` 0、`pnpm test` 919/918+1skip/0、`pnpm build` 0、smoke 通过、`git diff --check` 0；浏览器 11/11；证据 `2026-10-29-round-five-integration.md`；集成提交见该记录 |
| Review | 交叉审查 | 独立核对三包实现与证据 | B/C/D | 已完成：APPROVE WITH FIXES → 3 blocker（`knowledge:maintain`、README 发布边界、C4-UI 混合任务）已修复/待随集成提交；N1—N9 见集成记录 §6 |

## W0 冻结接口（实现以此为准）

- `TaskManifest.publications?: PublicationPin`（服务端解析写入；旧 manifest 无该字段仍可解析；浏览器提交被拒）；解析器三态 `pinned|none|blocked`，未注册解析器 → 503；`TASK_CATALOG_VERSION = 4`。
- 发布版本固定：`registerPublicationResolver`（C6 `startKnowledgeRuntime` 导出，Lead 在 `instrumentation.ts` 先于 `startTaskRunner` 接线）。
- 文书成果：`specialty-subcontract`、`supplementary-agreement` 属 machine-only + server-owned；浏览器普通成果 POST 不可写；结果 value 内嵌模板 id/version/sha、输入版本、字段、缺失与正文；模板固定“待核对” ⇒ partial + `TEMPLATE_UNREVIEWED`，不可批准。
- 材料快照读取：`readParseSnapshot` 返回 `fragments`（按文档顺序），用于要求手工录入的来源选择；既有字段为增量，不破坏旧消费方。
- 迁移：0011 = C6（publications/publication_versions，唯一约束、核对字段可空）；0012 = C5（drafting_inputs/drafting_input_versions，`UNIQUE(project_id,operation_id)`）；Lead 在集成时注册并冻结 checksum。
- 规范库 P1 不交付，保留空状态。

## 冻结写作用域

- Agent B：`verifications-client.ts`(+test)、`project-verification-workspace.tsx` + `verification-*`、`materials-client.ts`（快照读取扩展）；证据 `-c4-ui.md`。
- Agent C：`src/server/knowledge/**`、`scripts/knowledge-maintenance.mts`、`reviews/{input,executor,runner,runtime,registry}.ts`、`tools/contract-review/src/{pack,runner,review}.ts`；证据 `-c6.md`。
- Agent D：`src/server/templates/**`、`src/server/drafting/**`、`drafting-client.ts`、`project-drafting-*`、`/api/projects/[id]/drafting-inputs|drafts`；证据 `-c5.md`。
- Lead：spec、tasks、migrations、results/exports 注册、materials、host shell、instrumentation、package.json、文档、提交。

## 未决与外部门槛

- 无真实领域核对人/签核：不得产生真实 published pack 或已核对模板；C6 测试夹具与 C5 模板均为“待核对/合成”，证据必须标注。
- 无真实 OCR/MaaS/OBS/GaussDB/公网 HTTPS/CI/Docker；浏览器验收仅本机 Edge + 合成数据。
- AC-05/AC-07/AC-11/AC-22/UI-23 整项不做通过声明；C5 正文/章节人工编辑与催款函、C4 机器候选路径（模型不可用时）单列未运行。
- 本机持久开发库若已应用 0010，不得改 0010 内容；0011/0012 注册后同样冻结。
