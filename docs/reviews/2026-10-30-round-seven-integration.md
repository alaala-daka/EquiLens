# 第七轮 B 线集成记录与验收证据

日期：2026-10-30。基线：`9483502`（远端 `8ccb090` 已合入）+ W0 提交 `38416bd`（规格、迁移 0014、任务目录 4→5、共享 DTO）。
本记录对应计划 `2026-10-30-round-seven-plan.md` 的 B1a/B3a/B2b 与 I1，不替代领域验收、真实云平台验收或独立业务质量集。
所有改动为本地改动，未推送、未部署、未创建 Issue。

## 1. 环境

- Windows 本机、Node.js v24.16.0、pnpm 11.6.0、SQLite（`node:sqlite`）。
- 全新临时库 `.superpowers/round7/app.sqlite`：启动时自动补齐迁移 **0001—0014**（含 0014 事实版本表）。
- 开发合成对象存储 `EQUILENS_SYNTHETIC_STORAGE=1`（`.superpowers/round7/objects/`）；合成 DOCX 材料；合成项目与成员。
- 本地 dev 服务 `http://127.0.0.1:3000`，`APP_ORIGIN` 同值；引导超管 `round7admin`，只读成员 `r7viewer`（`pnpm account:maintain` 创建）。
- 模型：`.env.local` 配置的真实 `deepseek-flash`（`AI_BASE_URL=https://api.deepseek.com/v1`）。未使用演示答案或预制成果。

## 2. 交付范围（对照计划 §5）

| 包 | 交付 | 关键文件 |
| --- | --- | --- |
| B1a 项目事实 | 迁移 0014 事实仓储（幂等 operationId、基础版本冲突、摘要/sha256 复验、跨项目过滤）、事实服务与 4 条项目路由、`document-analysis` 执行器与 `fact-candidates` 校验器、事实客户端与「项目事实」面板（材料选择、任务轮询、候选确认/更正、历史、冲突高亮、未保存保护、只读视图） | `src/server/facts/**`、`src/app/api/projects/[id]/facts/**`、`src/lib/business/facts-client.ts`、`src/components/business/platform/project-facts-panel.tsx`、`fact-draft.ts` |
| B3a 款项核对 | 受控款项保存/修订（服务端重算、来源与事实版本重验）、`payment-reconciliation` 校验器与 `payment-reconciliation-v1` 导出模板、款项客户端、款项面板与行编辑器、组合壳 | `src/server/payments/**`、`src/app/api/projects/[id]/payments/**`、`src/lib/business/payments-client.ts`、`src/components/business/platform/project-payments-panel.tsx`、`payment-row-editor.tsx`、`project-payments-workspace.tsx` |
| B2b 审查处理决定 | `contract-review` 移出 machineOnly、新增 `existingOnly`/`noReview` 策略、只允许 `findingDecisions` 变化的投影全等校验、`contract-review-report-v2` 导出模板、审查工作区逐条处理与修订保存 | `src/server/results/{service,access,registry}.ts`、`src/server/reviews/{registry,export-template}.ts`、`src/components/business/platform/{project-review-workspace,review-result-panel,review-draft}.tsx`、`src/lib/business/reviews-client.ts` |
| I1 接线与证据 | 注册表/导出模板/`instrumentation` 接线、C7 删除清单与投影测试适配、浏览器验收脚本 `verify:r7`、本记录 | `src/server/exports/template.ts`、`src/instrumentation.ts`、`src/server/projects/lifecycle-schema.ts`、`scripts/verify-round-seven-browser.mts` |

## 3. 门禁（实际执行）

| 命令 | 结果 |
| --- | --- |
| `pnpm check`（`eslint --max-warnings 0` + `next typegen` + `tsc --noEmit`） | exit 0 |
| `pnpm test` | **1017 tests / 1015 pass / 2 skip / 0 fail**（两项跳过均为 Linux 文件/目录 fsync 验证），原始输出 `.superpowers/round7/test-final2.log` |
| `pnpm build`（默认 Turbopack 构建 + `prepare-standalone`） | exit 0（本轮未出现 Turbopack CSS 子进程异常，未使用 webpack 替代） |
| `pnpm smoke`（standalone `pnpm start` @3000） | 通过：`/healthz`、登录页 HTML、打包样式表、`/brand.svg` |
| `git diff --check` | exit 0（无空白错误；`facts/repository.ts` 行尾已统一为 LF） |

生产 standalone 在本机 HTTP 下**认证不可用**：`authConfig` 要求生产 `APP_ORIGIN` 为 HTTPS，`http://127.0.0.1:3000` 被 fail-closed 拒绝；同时开发合成对象存储在 `NODE_ENV=production` 下停用（`Private artifact recovery unavailable`）。因此 `pnpm smoke` 只覆盖健康检查、页面、静态资源；业务路径在 dev 模式完成验收。真实 HTTPS 部署与 OBS 仍属外部缺项。

## 4. 浏览器验收（`pnpm verify:r7`，Edge headless，33/33 通过，0 项未运行）

脚本先经 HTTP 建立合成项目（两份 DOCX 上传并解析、预算、只读成员、事实、款项成果、审查任务），再用系统 Edge 验证真实页面。截图与下载在 `.superpowers/round7/browser/`，摘要 `browser-acceptance.json`。

| # | 检查项 |
| --- | --- |
| 1 | 管理员登录 |
| 2 | 只读成员登录 |
| 3 | 创建项目、预算与只读成员 |
| 4 | 合成材料上传并解析（两份均 success） |
| 5 | 人工陈述事实保存为不可变版本（v1，证据状态「仅人工陈述」） |
| 6 | 事实更正生成版本链（v2，`supersedesVersionId` 指向 v1） |
| 7 | 过期基础版本更正返回 409 `CONFLICT` |
| 8 | 引文不符返回 422 `INVALID_SOURCE` |
| 9 | 跨项目来源返回 422 `INVALID_SOURCE` |
| 10 | 材料冲突事实保留，已确认不清除冲突（证据状态「材料冲突」） |
| 11 | 事实列表与历史可读（历史按版本降序） |
| 12 | 事实读权限与写权限分离（viewer 读 200 / 写 403 / 未登录 401） |
| 13 | 款项核对保存并确定性计算：计付基数 1,000,000.00 × 80% − 已付 300,000.00 = **500,000.00 元**（`800000.00 − 300000.00 = 500000.00 元`），非以计量额直接相减 |
| 14 | 浏览器提交 `calculation` 被拒绝（400 `INVALID_INPUT`） |
| 15 | 款项引用未确认事实返回 422 |
| 16 | 只读成员不能保存款项表（403） |
| 17 | 未确认款项只形成草案（`status=draft`、`partial`、`PAYMENT_DRAFT`），草案不能批准（422） |
| 18 | 款项修订另存新版本且拒绝过期基础版本（200 / 409） |
| 19 | 款项重验 → 复核批准 → 导出 → 下载闭环（导出 sha256 `7207da56…`） |
| 20 | 合同审查不允许人工新建成果（403） |
| 21 | 事实准备任务完成（真实模型，`success`，调用 1 次） |
| 22 | 合同审查处理决定另存新版本（19 条发现，修订后复核重置） |
| 23 | 合同审查机器字段不可改写（改写引文 400） |
| 24 | 业务处理内业务选择含「款项核对」 |
| 25 | 「项目事实」「款项表」两个区域页签可见 |
| 26 | 项目事实列表显示「材料支持」「材料冲突」与更正后版本 2 |
| 27 | 机器候选事实可打开「确认事实」对话框（候选 4 条，拒绝 0 条） |
| 28 | 款项成果展示确定性计算结果与「校验：通过」 |
| 29 | 浏览器「重新校验」通过 |
| 30 | 款项 Word 导出下载（浏览器下载 sha256 与 API 导出一致） |
| 31 | 合同审查工作区保存处理决定修订（「修订版本已保存」） |
| 32 | 只读成员界面隐藏「新增事实」「保存款项表」 |
| 33 | 无浏览器页面错误 |

真实模型调用记录（来自任务表）：

| 任务 | 状态 | 调用 | 计费（分） | 耗时 | 结果 |
| --- | --- | --- | --- | --- | --- |
| `document-analysis`（事实准备） | success | 1/3 | 100 | 8119 ms | 4 条候选、0 条拒绝，`fact-candidates` 成果 valid |
| `contract-review`（合同审查） | success | 11/25 | 1320 | 44133 ms | 19 条发现，机器成果 valid |

## 5. 验收中发现并修复的缺陷

1. **事实准备任务必然失败（推理模型 token 预算）**：执行器请求 `max_tokens: 4096`，`deepseek-flash` 为推理模型，4096 completion token 全部消耗在 `reasoning_tokens`，`finish_reason=length`、`content` 为空；执行器按「未完整返回」直接失败（1/3 调用即终态 failed）。探针复现（`completion_tokens_details.reasoning_tokens=4096`、`content` 长度 0），改为 `max_tokens: 8192` 并请求 `response_format: json_object`（与已验证的审查网关一致）后，同一任务 `success`、1 次调用产出 4 条候选。已在 `facts/project-facts.test.ts` 增加请求体断言，避免回退。
2. **lint 门禁失败**：`src/server/tasks/repository.test.ts` 保留未使用的 `ref` 导入（catalog 4→5 改动遗留）；移除后 `pnpm check` 通过。
3. **行尾混用**：`src/server/facts/repository.ts` 末行为 CRLF，统一为 LF。
4. **候选引文校验不一致**：执行器用严格 `includes`，事实保存路径用 `quotesMatch`（NFKC + 空白归一化）。执行器改用 `quotesMatch`，避免模型输出空白差异被误判为「不能定位于所选片段」。
5. **计划要求的回归断言缺失**（独立审查发现，本轮补齐）：
   - `src/server/results/http.test.ts` 新增 R7 旁路回归：浏览器新建 `contract-review` 403；带 `resultId` 的修订改写 findings/coverage/status 400；`serverOwned`/`machineOutput`/`options` 等键 400；仅 `findingDecisions` 变化 200 且复核重置。
   - `src/server/results/registry.test.ts` 更新陈旧的「contract-review 是唯一 kind / 人工写入一律拒绝」断言为第七轮生产策略（machineOnly 含 fact-candidates、payment-reconciliation；existingOnly 含 contract-review），避免陈旧断言掩盖回归。
   - `src/server/document-agent/projection.test.ts` 补 legacy 投影 `operation_id` 非空且唯一的断言（计划 §4.2）。

## 6. 独立只读交叉审查

审查快照 2026-10-30 17:52，未修改文件、未运行测试/构建。**阻断项 0，建议项 12**。
已读确认无问题：跨项目 ID 一律按 `project_id` 过滤且不泄漏存在性；viewer 写路径服务端 403；事实 payload sha256 每次读取复验、evidenceStatus 服务端派生、幂等 + CAS + 唯一约束；款项唯一写入为 serverOwned、校验器 canonical 全等重算、草案不可批准；B2b 机器字段投影比较与 sources/dependencies 服务端复制；四个策略集合与构造顺序一致、`fact-candidates` 无导出且不可复核；执行器只在 lifecycle ready 后注册一次且逐阶段重验授权/保留期；UI 无工程化文案、无自定义 CSS、只读成员隐藏写操作；0014 入账本并纳入项目删除清单。

未采纳但记录在案的建议（不属本轮阻断项，留后续）：瞬时 429/5xx 自动重试（spec §9）、`ResultService` 现状 `issues.length > checked.issues.length` 的状态推导可加契约断言、通用 `POST /results` 仍接受 body 内 `resultId`（当前不可利用）、事实更正可改写 `originalValue`（旧值仍在历史中）、`payment-reconciliation` 值缺计算器版本号、审查「已有导出」未按版本过滤、金额输入即时写入非法草稿值、空状态未统一使用 `Empty` 组件、行编辑器未提示「付款行期间须与到期行一致」。

## 7. 不宣称与外部缺项

- 不宣称 B 线完成：B4 证据整理、B5 催款函、四业务主线端到端演练与 B 线验收留第八轮。
- 不宣称 AC-06/07/08/09/10/11/15/19/20/22 整项通过：无 24/60 独立业务质量集、无领域规则/模板签核、无真实 OBS/GaussDB/OCR/MaaS 配额与定价验证。
- 未运行：真实 GaussDB、OBS、OCR、公网 HTTPS、Docker/Linux 容器、GitHub CI、Microsoft Word 人工版式验收、完整项目备份恢复演练（本机 SQLite 合成路径已在第六轮记录）。
- 生产 standalone 在本机 HTTP 下认证按设计 fail-closed（需 HTTPS 源与真实对象存储），不以 `pnpm smoke` 冒充业务验收。
- `payment-reconciliation`/`evidence-organization`/`collection-letter`/`result-export` 任务类型仍未开放；本轮款项成果只经受控成果服务保存。
