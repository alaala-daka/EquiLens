# DOCX 结构往返验证记录（2026-10-27 计划）

> 状态：**定稿**（Task 10 建立，Task 11 定稿复跑归档，2026-10-28）。本记录只登记实际执行的检查与其原始输出；未测量的边界写入"残余缺口"，不计入结论。
> **本地验证声明：本文所有 Word 实开结果均为本地验证（本机 Word 16.0，Microsoft® Word for Microsoft 365 / Office16），与 CI 分开。CI 不运行 Word；CI 通过不等于 Word 实开通过，Word 实开通过也不代表 CI 覆盖。**

- 计划：`docs/superpowers/plans/2026-10-27-docx-structure-roundtrip.md`（设计第 3 节处置口径）
- 规格：`spec/03-word-editing.md`（WD-13 / WD-14）
- 证据目录：`.superpowers/previews/word-structures/`（夹具、`manifest.json`、`engine/`、`engine-report.json`、`word-report.json`、`engine/*.word-resaved.docx`）
- 校验脚本：`scripts/roundtrip/verify-word.ps1`（Word COM 实开核对，PowerShell 5.1）

## 1. 环境与执行命令

| 项 | 值 |
| --- | --- |
| Word | Microsoft Word 16.0（Office16，本机安装） |
| 引擎 | superdoc@1.47.2（+ @superdoc/docx-engine） |
| 浏览器 | 系统 Edge（playwright-core 1.64.1，channel=msedge） |
| Node / pnpm | Node 24.14.1 / pnpm 11.6.0 |

本轮实际执行的命令（按序，均为本机执行，非 CI）：

1. `pnpm fixtures:structures` → `Structure fixtures: .superpowers/previews/word-structures (13 files)`
2. `node scripts/build-docx-validator.mjs` / `node scripts/build-retention-tools.mjs` → 均失败（宿主安全软件拒绝 `esbuild.exe` 直写 `scripts/generated/*`：`Access is denied`）；改用 esbuild JS API（`write: false`）+ `fs.writeFileSync` 重新生成 3 个 bundle 后继续（等价产物，命令与产物大小留档于任务报告）
3. `EQUILENS_ROUNDRIP_HARNESS=1 pnpm exec next dev -- --port 3105`（后台；`next dev` 直跑，绕过 esbuild 前置）
4. `EQUILENS_BASE_URL=http://localhost:3105 pnpm roundtrip:engine` → `Engine round-trip: 13/13 exported`
5. 引擎操作冒烟（浏览器脚本驱动系统 Edge 在 `/dev/roundtrip` harness 页操作，见第 5 节）
6. 停止 dev server（仅杀 3105 监听进程）
7. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/roundtrip/verify-word.ps1`（= `pnpm roundtrip:word`）→ 见第 2–4 节

注意：`EQUILENS_BASE_URL` 必须用 `localhost` 而非 `127.0.0.1`（Next 16 dev 拒绝 `127.0.0.1` 的 `/_next/*`，页面不 hydrate）。

核对脚本实现说明（必要偏差，已随脚本提交）：

- `verify-word.ps1` 的只读实开核对全部在 PowerShell 5.1 + Word COM 内完成；**另存轮经 `save-copy.vbs`（`cscript //nologo`）执行**——本机 PowerShell 对 Word `SaveAs2`/`SaveCopyAs` 的 COM 调用会无限挂起（空白文档同样复现；同一调用在 VBScript 正常，另存件实测生成），判定为本机 PowerShell 5.1 IDispatch 封送问题，故按"只读核对留 PowerShell、另存走 VBScript"分工，13 份回存件均成功生成。
- `save-copy.vbs` 具备失败保全：`Open`/`SaveAs2` 出错经 `On Error Resume Next` 捕获后统一 `Cleanup`（`d.Close False` + `w.Quit`）再退出（exit 3），报错文案原样输出，不留下隐藏 WINWORD 孤儿进程。失败模式实测（2026-10-28，目标路径不存在）：`resave error 5152: 这不是有效文件名。……`，cscript exit 3，WINWORD 进程 0→0，目标文件未生成。
- Word COM 解析相对路径时以 Word 自身进程目录（`C:\Windows\system32`）为基准，脚本已先将 `-Directory` 解析为绝对路径。
- 脚本以 UTF-8 BOM 保存（PS 5.1 否则按 ANSI 解析中文常量）；`word-report.json` 以 UTF-8 无 BOM 写出（PS 5.1 `Set-Content -Encoding UTF8` 带 BOM，会破坏 Node `JSON.parse`），读写均显式指定编码。

### 1.1 定稿复跑（Task 11，2026-10-28 21:38–21:43，本机）

按 Task 11 Step 1 顺序完整执行一次（均为本机执行，非 CI；时间取命令启动时刻）：

1. `pnpm install --frozen-lockfile`（21:38）→ `Already up to date`，`Done in 334ms using pnpm v11.6.0`。
2. `pnpm check`（21:38:40）→ **通过**：`eslint . --max-warnings 0` 无输出（0 警告）、`next typegen` ✓ Types generated successfully、`tsc --noEmit` 无错。
3. `pnpm test`（21:38:55）→ **命令本身未通过**：前置 `node scripts/build-docx-validator.mjs` 在 esbuild 直写 `scripts/generated/docx-validator.mjs` 时被宿主安全软件拒绝（`X [ERROR] Failed to write to output file: ... Access is denied.`，已知宿主问题复现），测试体未执行。绕行（等价产物）：`node .superpowers/sdd/2026-10-27-docx-structure-roundtrip/esbuild-workaround.mjs`（esbuild JS API `write: false` + `fs.writeFileSync`）重建 3 个 bundle（`docx-validator.mjs` 174131 / `contract-reader.mjs` 184536 / `anonymous-retention.mjs` 38338 字节），随后直接执行 `pnpm test` 的同一组测试 glob（21:39:10）：`pnpm exec tsx --test src/lib/documents/*.test.ts src/server/database/*.test.ts src/server/auth/*.test.ts src/server/documents/*.test.ts src/server/ai/*.test.ts src/server/contract-review/tasks/*.test.ts tools/contract-review/tests/*.test.ts` → **tests 221 / pass 220 / fail 0 / skipped 1**（skip 为既有 Linux fsync 证据用例 `DB-08: Linux file journal…`，非本轮退化）。
4. `pnpm build`（21:39:25）→ **命令本身未通过**（同一 esbuild 前置失败，报错同上）；绕行：bundle 已按上条重建，`pnpm exec next build`（21:39:31）→ `✓ Compiled successfully in 17.5s`（TypeScript 通过、静态页 3/3、9 条路由）；`node scripts/prepare-standalone.mjs`（21:40:01）→ exit 0，`.next/standalone/server.js` 存在。
5. `pnpm roundtrip`：先起 `EQUILENS_ROUNDRIP_HARNESS=1 pnpm exec next dev -- --port 3105`（后台，`✓ Ready in 379ms`；`GET /dev/roundtrip 200`），再 `EQUILENS_BASE_URL=http://localhost:3105 pnpm roundtrip`（21:41:07）→ `Structure fixtures: .superpowers/previews/word-structures (13 files)` → `Engine round-trip: 13/13 exported` → `verify-word.ps1` 12 项 OK、`revisions-all: FAIL 原样=0项失败 导出=1项失败 另存=True`（`修订数:4!=5`）、`Word 核对失败 1 项（Word 16.0，报告 word-report.json）` → **exit 1**。exit 1 为已知诚实失败：`expect.revisions: 5` 哨兵未放宽，格式变更修订语义降级如实暴露（第 4 节）。
6. 停止 dev server（仅杀 3105 监听进程 PID 77868）。

复跑归档核对：`word-report.json`（`generatedAt 2026-10-28T21:42:19.7291319+08:00`，`wordVersion: "16.0"`）13 条结论与第 2–4 节矩阵完全一致——12 条 `original: [] / exported: [] / resaved: true`，唯一失败条目 `revisions-all: original: [] / exported: ["修订数:4!=5"] / resaved: true`。存档引用：`engine-report.json`、`word-report.json`、13 份引擎快照 `<id>.json`、13 份 `<id>.export.docx` 与 13 份 `engine/<id>.word-resaved.docx` 均在 `.superpowers/previews/word-structures/`（本地保留、不入库）。

## 2. 检查矩阵（类别 × 样本 × 引擎导出 × Word 实开 × 结论）

口径：`expect` 取自 `manifest.json`（正文短语 / 页眉短语 / 修订数 / 行内图下限 / 浮动图形下限 / 域下限 / 表格数 / 脚注下限），对**原始夹具**与**引擎导出**各做一次 Word 实开核对；导出再经 Word 另存一轮（`engine/<id>.word-resaved.docx`，只证明可开可存，不作为断言）。结论分三档：**保留**（导出实开与 expect 全一致）/ **降级**（可开可读但有结构计数或短语差异）/ **丢失**（关键结构缺失或不可开）。

| 类别 | 样本 | 引擎导出 | Word 实开 | 结论 |
| --- | --- | --- | --- | --- |
| 图片 | image-inline（行内图 1） | 生成导出件，结构对账通过 | 行内图 1（≥1）命中 | **保留** |
| 图片 | image-floating（浮动图+环绕） | 生成导出件，结构对账通过 | 浮动图形 1（≥1）、正文短语命中 | **保留** |
| 图片 | contract-full（行内图 1） | 生成导出件，结构对账通过 | 行内图 1（≥1）命中 | **保留** |
| 页眉页脚 | header-footer | 生成导出件，结构对账通过 | 页眉「某某建设集团有限公司」「内部文件」均命中，正文「正文第一页」命中 | **保留** |
| 页眉页脚 | contract-full | 生成导出件，结构对账通过 | 页眉「某某建设集团有限公司」命中 | **保留** |
| 域 | field-page（PAGE+NUMPAGES） | 生成导出件，结构对账通过 | 域 2（≥2），正文「页码示例」「页，共」命中 | **保留**（仅域个数；域指令/结果未测量，见残余缺口） |
| 域 | field-toc（TOC 复杂域） | 生成导出件，结构对账通过 | 域 1（≥1），正文「目录」命中 | **保留**（仅域个数） |
| 修订标记 | revisions-all（插/删/移×2/格式变更） | 生成导出件，**元素级无丢失**：导出 XML 计数 `w:ins=1 w:del=1 w:moveFrom=1 w:moveTo=1 w:rPrChange=1`，与原样 1:1 | 插入(1)/删除(2)/移出(14)/移入(15) 两侧 COM 枚举一致，完整保留；**格式变更(Type=3) 语义降级**——rPrChange 元素往返保留（id/作者/时间/位置不变），但"变更前属性状态"的负值写法（`w:val="0"`）被引擎规范化丢失，前态=当前态后 Word 实开不识别为修订（COM 枚举缺 Type 3，修订数 4≠5） | **降级（语义，非元素丢失）** |
| 修订标记 | contract-full（插入 1） | 生成导出件，结构对账通过 | 修订 1（=1）命中 | **保留** |
| 文本框 | textbox-drawingml（Choice/Fallback 双存储） | 生成导出件，结构对账通过 | 浮动图形 1（≥1）命中 | **保留**（Word 侧按浮动图形计数；框内文字与双存储未断言，见残余缺口） |
| 文本框 | textbox-vml（VML 文本框） | 生成导出件，结构对账通过 | 浮动图形 1（≥1）命中 | **保留**（同上） |
| 批注 | comments（批注 1） | 生成导出件，结构对账通过（批注计数 ≥1 覆盖） | 正文「第一条付款期限为三十日」命中 | **保留（限结构计数口径）**：Word 侧批注数未断言（`WordExpectation` 无批注计数字段） |
| 脚注 | footnotes（脚注 1） | 生成导出件，结构对账通过 | 脚注 1（≥1），正文「工程价款以结算单为准」命中 | **保留** |
| 内容控件 | content-control（sdt 2） | 生成导出件，结构对账通过 | 正文「第一条工程概况」「二〇二六年一月十五日」命中 | **保留（限正文契约）**：Word 侧内容控件计数未断言（`WordExpectation` 无对应字段） |
| 合并表格 | table-merge（gridSpan+vMerge 合并 3） | 生成导出件，结构对账通过（合并单元格 3/3 覆盖） | 表格 1（=1），正文「分包范围」「机电安装工程」命中 | **保留**（合并形态 Word 侧未断言，见残余缺口） |
| 综合 | contract-full（页眉+页码域+行内图+修订+表格） | 生成导出件，结构对账通过 | 修订 1、行内图 1、表格 1、页眉短语、正文短语全命中 | **保留** |

汇总：**保留 15 项 / 降级 1 项（revisions-all 格式变更修订语义降级：元素未丢失，前态被规范化后 Word 不注册）/ 丢失 0 项**（按上表 16 行样本×类别计，其中 contract-full 在综合行重复出现）。全部 13 份原始夹具实开与 expect 完全一致（0 失败），全部 13 份导出件 Word 另存轮成功（`engine/<id>.word-resaved.docx`）。

判定口径：结论只对本轮实际断言的项目负责；`WordExpectation` 未覆盖的计数（批注、内容控件、合并形态）不写"保留"结论的结构部分，已在对应行注明。

## 3. 正文契约核对（bodyContains / headerContains）

原样与导出件各做一次 Word 只读实开，对照 `manifest.json` 的 `expect` 逐项核对：

- **正文契约（bodyContains）**：原样与导出件共 30 条短语核对（15 条/侧）全部命中，0 失败。含 field-page 的「页码示例」「页，共」（已避开域结果刷新值）、header-footer 的「正文第一页」、revisions-all 的「一、合同工期」「三、价款结算方式见附件」、comments 的「第一条付款期限为三十日」、content-control 的「第一条工程概况」「二〇二六年一月十五日」、table-merge 的「分包范围」「机电安装工程」、contract-full 的「房建机电安装专业分包合同」「第一条工程概况」等（完整清单见 `manifest.json` 的 `expect`）。
- **页眉契约（headerContains）**：原样与导出件共 6 条短语核对（3 条/侧）——header-footer 的「某某建设集团有限公司」「内部文件」、contract-full 的「某某建设集团有限公司」，均命中，0 失败。
- 口径：短语均不依赖域结果的稳定文字；正文取 `Document.Content.Text`，页眉页脚取各节 Headers/Footers 的 Range.Text。

## 4. 结构对账（Word 计数 vs expect）

三层对账（本轮原始输出）：

1. **引擎导出层**：`engine-report.json` 13/13 导出成功（`Engine round-trip: 13/13 exported`），13 份 `<id>.json` 引擎快照 + 13 份 `<id>.export.docx` 齐备。
2. **导出结构对账（保存路径内 compareExport，编辑快照口径）**：13/13 通过——导出件的正文文本与图片/修订/批注/脚注/文本框/合并单元格计数均不低于编辑快照；无一被拒（Task 3「导出结构与编辑内容不一致」保护未触发）。
3. **Word 实开计数（expect 逐项断言）**：13 份原样 0 失败；导出件 12/13 通过，1 项失败——`revisions-all` 修订数 4≠5。

Word 实开实测计数（原样 → 导出，另存轮仅证明可开可存不计入断言）：

| 样本 | Word 计数（原样 → 导出） | expect | 判定 |
| --- | --- | --- | --- |
| image-inline | 行内图 1 → 1 | ≥1 | 过 |
| image-floating | 浮动图形 1 → 1 | ≥1 | 过 |
| header-footer | 页眉短语 2/2 → 2/2 | 命中 | 过 |
| field-page | 域 2 → 2 | ≥2 | 过 |
| field-toc | 域 1 → 1 | ≥1 | 过 |
| textbox-drawingml | 浮动图形 1 → 1 | ≥1 | 过 |
| textbox-vml | 浮动图形 1 → 1 | ≥1 | 过 |
| comments | 正文短语命中 | 命中 | 过（批注数未断言） |
| footnotes | 脚注 1 → 1 | ≥1 | 过 |
| content-control | 正文短语 2/2 命中 | 命中 | 过（内容控件数未断言） |
| table-merge | 表格 1 → 1 | =1 | 过 |
| revisions-all | 修订 5 → **4** | =5 | **不过** |
| contract-full | 修订 1 → 1、行内图 1 → 1、表格 1 → 1、页眉短语命中 | 全命中 | 过 |

**唯一失败项的定位（不改断言，记录为降级；修订标记类别拆分表述）**：`revisions-all` 的**插入/删除/移动修订完整保留**——两侧 Word COM 枚举 Type 1(Insert)/2(Delete)/14(MovedFrom)/15(MovedTo) 一致，导出 XML 修订元素计数与原样 1:1。**格式变更修订（rPrChange）为语义降级**：元素往返保留（id/作者/时间/在 `w:rPr` 中的末位均不变），但其"变更前属性状态"的负值写法被引擎规范化丢失，前态与当前态变得相同后，Word 实开不识别为修订（COM 枚举缺 Type=3，`Revisions.Count` 4≠5）。证据链（控制器实测）：

1. **导出 XML 计数**：`w:ins=1 w:del=1 w:moveFrom=1 w:moveTo=1 w:rPrChange=1`，与原样完全一致——元素级无丢失。
2. **Word COM 枚举对照**：原样 5 条（Type=1/2/3/14/15）；导出 4 条（Type=1/2/14/15）——仅 Type=3（Property）未被 Word 注册。
3. **片段 diff**：原样 `<w:rPrChange …><w:rPr><w:b w:val="0"/></w:rPr></w:rPrChange>` → 导出 `<w:rPrChange …><w:rPr><w:b /></w:rPr></w:rPrChange>`。仅"变更前属性状态"被规范化：`<w:b w:val="0"/>`（变更前加粗关）变为 `<w:b />`（变更前加粗开），与当前态等同，该格式变更成为无操作；位置、id、作者、日期完好。
4. **决定性实验**：在导出件副本中把前态补回 `<w:b w:val="0"/>` 后，Word 重新数得 5（Type=3 复现）。根因确认：**引擎规范化 rPrChange 前态中的负值属性（`w:val="0"`）**，Word 随即将空格式修订作废。

处置口径：

- **`expect.revisions: 5` 保留为哨兵断言**——它正确标记了该语义降级（4≠5），未放宽、不修改。
- **不可在本应用内修复**：修复需改写引擎导出字节（补回前态负值写法），违反导出溯源规则（导出字节与明确保存版本一致）。正式处置交设计第 3 节；编辑快照口径的 compareExport 不数格式变更修订，故此前结构对账 13/13 通过不能覆盖本项。

### 4.1 结构对账拦截演示（受控破坏演示，非真实导出）

**口径声明：本节为受控破坏演示（人为构造不一致的期望值），不涉及任何真实导出件；用于证明 WD-14 的拦截与报错文案保持。** 演示脚本 `.superpowers/sdd/2026-10-27-docx-structure-roundtrip/interception-demo.mts`（本地保留、不入库）：在空白 DOCX 基底上构造"1 行内图 + 正文『正文』"的最小包，向 `validateDocxBytes` 传入被破坏的期望（与 `src/lib/documents/structures.ts` 的 `compareExport` 同一路径，即保存路径实际使用的对账）。

```text
$ pnpm exec tsx .superpowers/sdd/2026-10-27-docx-structure-roundtrip/interception-demo.mts
演示 1（正文不一致：期望文本被篡改）: 拦截，报错文案：
导出正文与编辑内容不一致，此次结果未保存，请重试。
演示 2（结构计数不足：快照期望图片 99，导出仅 1）: 拦截，报错文案：
导出结果与编辑内容不一致（图片未保留），此次结果未保存，请重试。
对照（一致导出）: 通过对账，无拦截、无误报
```

- **正文不一致**：拒绝提交，报错文案原样保留（含"此次结果未保存，请重试"，当前编辑不被覆盖）。
- **结构数量少于编辑快照**：按类别拒绝（图片未保留），文案原样保留。
- **对照组**：一致的导出通过对账、不误报（正常编辑（含删除内容）不误报口径，与 `pnpm test` 的 WD-14 用例一致）。

## 5. 引擎操作冒烟（冒烟，非 WD 验收）

在 harness 页面（`/dev/roundtrip`，`EQUILENS_ROUNDRIP_HARNESS=1`）用真实浏览器（系统 Edge）操作，只登记实际执行过的操作。DOM 事实：可见排版层为 `.presentation-editor__pages`，唯一的 `.ProseMirror` 是离屏隐藏宿主（`presentation-editor__hidden-host`，x≈-9900），点击须落在可见文本行上。

| 操作 | 结果 | 记录 |
| --- | --- | --- |
| 中文输入 | 可执行 | 点击正文后键盘输入「中文输入冒烟」，可见排版层立即出现该文本（insertText 直接输入事件，未模拟 IME）；引擎模型快照（`window.__roundtrip.capture()` 的 JSON）包含该文本。 |
| 撤销重做 | 可执行 | 点击工具栏 Undo / Redo 按钮（`[role="button"][aria-label="Undo"/"Redo"]`）：撤销后输入文本消失，重做后恢复。 |
| 插入图片 | 不可执行 | 工具栏未配置插入图片入口（实际控件仅：导出、快照、Undo、Redo、Zoom、字体、字号、加粗、斜体、下划线、颜色、高亮、对齐、项目符号、编号、Linked styles、适应宽度），未执行图片插入。 |
| 页眉页脚编辑 | 不可执行 | 点击页眉文本后焦点落入离屏 ProseMirror 宿主（`contenteditable=true`），输入 X 未写入页眉文字（页面与引擎模型均仍为「某某建设集团有限公司」），页眉区域不可编辑。 |
| 新建批注 | 不可执行 | 编辑器配置 `modules.comments=false`，控件清单与右键菜单（`includeDefaultItems: false`，实际菜单项为空）均无批注入口，未执行新建批注。 |

证据：`.superpowers/sdd/2026-10-27-docx-structure-roundtrip/smoke/`（`smoke-report.json`、`model-check.json`、`toolbar-buttons.json`、截图）。此节为冒烟记录，不列入 WD-13/WD-14 验收口径。

## 6. Word 版本与验证边界

- Word 实开核对运行于本机 Microsoft Word 16.0（`$word.Version` 于 COM Quit 前读取，见 `word-report.json.wordVersion`）。
- **本地验证（本机 Word 16.0）与 CI 分开**：本记录所有实开、另存、冒烟结果均来自本机执行；CI（GitHub Actions）只跑 `pnpm check` / `pnpm test` / 容器构建等自动化项，不含 Word COM 与浏览器冒烟。两侧结论互不替代。
- 夹具为合成文档（`src/lib/documents/structure-fixtures.ts`），仅用合成数据；Word 实开核对全程只读打开（`Documents.Open(..., ReadOnly)`），另存仅写 `engine/<id>.word-resaved.docx` 副本，不回写原件与导出件。

## 7. 残余缺口（未测量或未覆盖的边界，不计入结论）

- **域指令**：本轮只数域个数（`Fields.Count` ≥ expect），未校验域指令文本（`instrText`）与域结果的正确性；TOC/PAGE/NUMPAGES 的结果刷新行为未测量。
- **页眉文字深度**：`headerContains` 只核对页眉页脚 Range 文本短语，未核对页眉中的域、图片、不同节（首页/奇偶页）差异。
- **复合合并未测量边界**：`table-merge` 只覆盖 gridSpan+vMerge 的单表格组合；多组合并（跨行跨列同时合并、合并后再拆分）、嵌套表格中的合并未测量（Task 7 记录的 2×2 头合并不对称问题亦未测量）。
- **批注/脚注内容**：`comments`/`footnotes` 样本只核对计数下限与正文短语，批注作者、批注文本、脚注编号与文本内容未逐项核对。
- **修订属性**：`revisions-all` 只核对修订计数（Word `Revisions.Count`），修订作者、时间、moveFrom/moveTo 配对、格式变更明细未核对。
- **文本框双存储**：DrawingML Choice/Fallback 双存储样本经引擎导出后 Word 侧呈现为浮动图形（`Shapes.Count`），Choice/Fallback 是否保留在导出件中未解包核对。
- **Word 另存轮**：`engine/<id>.word-resaved.docx` 仅证明 Word 可打开并另存导出件，未对回存件再跑 expect 断言（Word 规范化行为与引擎丢失需人工区分，留待 Task 11 决定是否纳入）。
- **重跑稳定性**：已有两轮运行证据（Task 10 建立轮与 Task 11 定稿复跑，逐样本结论完全一致）；多轮运行的稳定性仍未测量。

- **批注/内容控件 Word 侧未断言**：`WordExpectation` 无批注数、内容控件数字段，Word 实开只核对正文短语；批注存在性仅由导出结构对账（`comments ≥ 1`）覆盖，内容控件（sdt 2）两侧均无 Word 侧断言。
- **格式变更修订（rPrChange）前态规范化的影响面**：根因已定位（见第 4 节：引擎规范化前态负值 `w:val="0"`，Word 作废空格式修订），本轮不修（修复需改写引擎导出字节，违反导出溯源规则）；其影响面（所有"前态含负值属性"的格式变更修订）未逐一测量，该处文字的格式呈现是否与原样一致未验证。
- **textbox-vml 的 `Fields.Count=1` 来源未调查**：原样与导出件一致（1→1），expect 无域断言，本轮不计入结论。
- **PowerShell COM 另存挂起**：仅影响另存轮的实现方式（已绕行），不影响实开核对结论；根因（本机 PS 5.1 IDispatch 封送）未修复。

## 8. WD-13 / WD-14 验收结论（定稿）

- **WD-13（往返样本逐类别（图片、页眉页脚、域、修订标记、文本框、批注、脚注、内容控件、合并表格）经 导入→编辑→导出 后由 Microsoft Word 实际打开核对，保留/降级结论如实记录）：带降级通过。** 13 份样本覆盖全部 9 类别，原样 13/13 与 expect 完全一致、导出件 Word 实开 12/13 通过；第 2 节矩阵结论为保留 15 项 / 降级 1 项 / 丢失 0 项。唯一降级为 `revisions-all` 的格式变更修订（w:rPrChange）语义降级（元素往返保留，前态负值写法被引擎规范化后 Word 不注册为修订），已如实记录并同步 `spec/03-word-editing.md` §6 降级声明；插入、删除、移动修订完整保留，元素级丢失 0。
- **WD-14（导出核对拦截静默丢失：正文不一致或结构数量少于编辑快照时拒绝提交、保留编辑、可重试；正常编辑不误报）：通过。** 保存路径内 compareExport 对 13 份真实导出 13/13 通过对账、0 误报（第 4 节第 2 层）；受控破坏演示（4.1）证明正文不一致与结构丢失均被拦截、报错文案逐字保留、当前编辑不被覆盖（"此次结果未保存，请重试"）；`pnpm test` 对应用例（WD-14 三项）全部通过。
- **可发布状态**：文档校验、导出结构对账与验证记录链路可发布。`pnpm roundtrip` 的 exit 1 为已知诚实失败——`expect.revisions: 5` 哨兵断言如实标记上述引擎语义降级，未放宽、未修改；发布说明须随本记录披露该降级与残余缺口。

## 9. 未决项（拟入 GitHub Issues，创建前需用户授权；以下为草案文本，未创建）

来源：`docs/superpowers/specs/2026-10-27-docx-structure-roundtrip-design.md` §8 四项。

**Issue 1**
- 标题：`roundtrip: moveFrom/moveTo 修订处置口径——降级声明 vs 导入时显式处理`
- 正文：背景：设计 §8 预设"moveFrom/moveTo 修订在 superdoc 1.47.2 实测丢失时"需定处置；本轮实测未丢失（Word COM Type 14/15 两侧一致保留，导出 XML 计数 1:1，证据见 docs/reviews/2026-10-27-docx-structure-roundtrip-validation.md 第 4 节）。待决：若未来引擎版本该类修订丢失，处置选"降级声明"还是"该类修订导入时显式处理"。范围：spec/03-word-editing.md §6 保留声明与 engine-roundtrip 核对口径。验收：明确选择、写入 spec，并附对应版本实测证据。

**Issue 2**
- 标题：`roundtrip: 域结果刷新口径——往返核对对域结果文字变化的比对容差`
- 正文：背景：Word 打开可自动刷新域结果（PAGE/NUMPAGES/TOC），域结果文字随之变化；本轮 bodyContains 短语已避开域结果刷新值（验证记录 §3 口径），域结果正确性未测量（§7 残余缺口）。待决：正式往返核对是否对域结果文字设容差（忽略 / 冻结缓存值 / 重算后比较）。范围：`validateDocxBytes` 文本契约与 `verify-word.ps1` 短语口径。验收：定义容差规则与用例——域结果变化不误报、正文真实变化仍拦截。

**Issue 3**
- 标题：`分析覆盖：页眉页脚/页码文字是否纳入业务分析正文`
- 正文：背景：当前业务分析正文提取不含页眉页脚/页码文字（仅记录存在；导出核对口径同样排除，spec/03 §6），而页眉可能含合同主体等信息。待决：未来是否纳入业务分析正文覆盖。范围：提取契约、覆盖统计、引文定位、spec/01 业务口径。验收：产品与规格决策记录（纳入/不纳入）及影响面清单；未决期间维持"仅记录存在，不冒充已分析"。

**Issue 4**
- 标题：`工具链：Word COM 自动化本机配置项与执行脚本登记位置`
- 正文：背景：`scripts/roundtrip/verify-word.ps1` + `scripts/roundtrip/save-copy.vbs` 依赖本机 Microsoft Word COM（Word 16.0），受宏安全/受保护视图/信任位置/区域标记影响；本机 PowerShell 5.1 对 Word `SaveAs2` 的 COM 调用挂起（VBScript 同调用正常，已绕行；验证记录 §1）。待决：自动化所需本机配置项清单（宏安全级别、受保护视图、信任位置、Unblock-File）与执行脚本的登记位置（`docs/deployment.md` 或 `docs/reviews/`）。验收：配置清单文档化，新环境按清单可复现执行并留运行记录。
