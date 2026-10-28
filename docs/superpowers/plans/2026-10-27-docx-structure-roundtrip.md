# DOCX 结构放行与往返验证 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 EquiLens 编辑器接受并往返保留含图片、页眉页脚、域、修订标记、文本框、批注、脚注、内容控件、合并表格的 DOCX，仅保留安全类拒绝，并以 Word 实开核对逐类别证明保留能力。

**Architecture:** 共享校验器从"结构白名单"改为"安全层 + 结构清单"；导出核对在正文文字比对上增加"结构对账"（编辑快照 vs 导出 DOCX）；分析侧用清单派生覆盖结论（ParseSnapshot.coverage）替代硬编码 `complete: true`。证据链：合成往返样本 → 浏览器引擎往返 → 本机 Word COM 实开核对 → 验证记录。

**Tech Stack:** Next.js 16.4 / React 19.3 / TypeScript、superdoc@1.47.2（精确锁定）、fast-xml-parser、fflate、node:test + tsx、playwright-core（devDependency，驱动本机 Edge）、PowerShell + Word COM（本机 Office16）。

**设计文档:** `docs/superpowers/specs/2026-10-27-docx-structure-roundtrip-design.md`（已获用户确认）。

## Global Constraints

- 依赖精确锁定：`superdoc@1.47.2` 不变，不装 v2 封装、不装 `@superdoc/docx-engine`；新增依赖仅 `playwright-core`（devDependency，精确版本）。
- 文件上限不变：单文件 20 MiB、解压总量 100 MiB、包条目 ≤ 2,000；加载/校验超时 60 秒（上传校验 15 秒）。
- 安全拒绝保留：宏/ActiveX/OLE/嵌入对象/嵌套压缩、外部资源与外链模板、DOCTYPE/ENTITY、`altChunk`、`object`；CSP、遥测关闭、同源资产不变。
- 正文提取契约（两端一致）：计入 `document.xml` 的 `w:t`（表格、文本框 Choice 分支、修订插入文字、域结果）；不计入 `w:delText`（含 moveFrom）、`w:instrText`、`mc:Fallback` 分支、页眉页脚/批注/脚注部件文字。
- 导出对账规则：正文精确相等；结构数量 **导出 ≥ 编辑快照**（相等为常态）。
- 文案规则：正式、简洁、任务导向；不加"本地预览/尚未接入/功能建设中"类装饰文案；报错只在失败时出现。
- UI 用官方 shadcn/ui 组件与官方 Blocks；本计划新增页面仅为验证工具（环境变量门禁，生产 404），不计入产品功能。
- 提交信息短命令式 `<type>: <summary>`（`docs:`/`feat:`/`fix:`）；`.superpowers/` 保持不入库；合成样本只用合成数据。
- 验证记录区分"本地验证"与"CI 检查"；CI 无 Word，不得声称 CI 通过 Word 核对。
- WD-01—WD-12 编号不动；新增 WD-13、WD-14；WD 结果不计入法律业务准确率分母。
- 共享文件 `src/components/word-canvas.tsx`、`src/lib/documents/*` 按 `docs/superpowers/plans/2026-10-27-three-person-development-plan.md` 属甲名下，动手前知会三方并按总计划交接约定执行。

## File Structure

| 文件 | 职责 | 动作 |
| --- | --- | --- |
| `spec/03-word-editing.md`、`spec/01-product.md`、`README.md`、`tools/contract-review/README.md` | 契约与操作说明 | 修改（Task 1） |
| `src/lib/documents/structures.ts` | 结构清单类型、快照/导出对账（纯函数） | 新建（Task 2） |
| `src/lib/documents/docx.ts` | 包级安全校验 + 结构清单 + 正文提取 | 修改（Task 3） |
| `src/lib/documents/structure-fixtures.ts` | 合成往返样本构建器（测试与脚本共用） | 新建（Task 4） |
| `scripts/docx-structure-fixtures.mts` | 样本落盘 + 预期清单 manifest.json | 新建（Task 5） |
| `src/app/dev/roundtrip/page.tsx`、`src/components/roundtrip-harness.tsx` | 引擎往返验证页（门禁工具） | 新建（Task 6） |
| `scripts/roundtrip/engine-roundtrip.mts` | 浏览器引擎往返驱动脚本 | 新建（Task 6） |
| `src/lib/documents/serialize.ts` | `editorText` 契约扩展 + `editorStructures` | 修改（Task 7） |
| `src/lib/documents/calibration/*.json` | 引擎 JSON 校准样本（固化夹具） | 新建（Task 6/7） |
| `src/lib/documents/validate.ts`、`docx.worker.ts`、`src/components/word-canvas.tsx` | 导出对账接线 | 修改（Task 8） |
| `tools/contract-review/src/document.ts`、`document-worker.ts`、`src/server/contract-review/tasks/repository.ts`、`runner.ts` | 解析覆盖（coverage） | 修改（Task 9） |
| `scripts/roundtrip/verify-word.ps1` | Word COM 实开核对 | 新建（Task 10） |
| `docs/reviews/2026-10-27-docx-structure-roundtrip-validation.md` | 验证记录 | 新建（Task 10/11） |

跨任务共享签名（后续任务依赖，改动须全局同步）：

```ts
// src/lib/documents/structures.ts
export type DocumentStructures = {
  images: number; headerFooterRefs: number
  fields: { simple: number; complex: number }
  revisions: { insertions: number; deletions: number; moves: number; formatChanges: number }
  textboxes: number; comments: number; notes: number
  contentControls: number; mergedCells: number
}
export type EditorStructureCounts = {
  images: number; revisions: number; comments: number; notes: number; textboxes: number; mergedCells: number
}
export type DocxInspection = { text: string; structures: DocumentStructures }
export type ExportExpectation = { text: string; structures: EditorStructureCounts }
export function countComparable(structures: DocumentStructures): EditorStructureCounts
export function compareExport(actual: DocxInspection, expected: ExportExpectation): void

// src/lib/documents/docx.ts
export function validateDocxBytes(bytes: Uint8Array, expected?: ExportExpectation): DocxInspection

// src/lib/documents/validate.ts
export async function validateDocx(blob: Blob, signal?: AbortSignal, prepare?: boolean, expected?: ExportExpectation): Promise<Blob>

// src/lib/documents/serialize.ts
export function editorText(value: unknown): string
export function editorStructures(value: unknown): EditorStructureCounts

// tools/contract-review/src/types.ts
export type ParseCoverage = { images: number; revisions: number; textboxes: number; complex: number }

// tools/contract-review/src/document.ts
export function parseDocxBytes(bytes: Uint8Array): { paragraphs: Paragraph[]; coverage: ParseCoverage }
export function coverageComplete(coverage: ParseCoverage): boolean
export async function readDocxInChild(bytes: Buffer, signal?: AbortSignal): Promise<{ paragraphs: Paragraph[]; coverage: ParseCoverage }>
```

---

### Task 1: 契约更新（spec/03、spec/01、README、tools README）

**Files:**
- Modify: `spec/03-word-editing.md`（§1 第 13—14 行、§3 第 59 行、§6 第 123—124 行、§7 表）
- Modify: `spec/01-product.md`（第 98 行附近）
- Modify: `README.md:48`
- Modify: `tools/contract-review/README.md:223`

**Interfaces:**
- Consumes: 设计文档 `docs/superpowers/specs/2026-10-27-docx-structure-roundtrip-design.md`
- Produces: 后续任务据以实现与验收的契约文本；WD-13、WD-14 定义

- [ ] **Step 1: 更新 spec/03 §1 范围段**

将第 13 行起的"先支持普通中文段落、标题、列表和简单表格。旧版 DOC、加密文件、宏、扫描件、修订模式、实时协作和任意复杂版式无损还原不进入本步承诺。"替换为：

```markdown
先支持普通中文段落、标题、列表和简单表格，并往返保留图片、页眉页脚、页码、域、修订标记、
文本框、批注、脚注/尾注、内容控件和合并表格等结构（保留能力以验证记录逐类别为准）。修订标记只保留、不编辑：不提供接受/拒绝、
不提供修订模式开关。旧版 DOC、加密文件、宏、扫描件、实时协作和任意复杂版式无损还原不进入本步承诺。
```

- [ ] **Step 2: 更新 spec/03 §3 操作边界**

将第 59 行"页宽、页边距、分页和中文字体用实际文件核对。不增加未验证的图片插入、复杂表格、评论或修订操作。"替换为：

```markdown
页宽、页边距、分页和中文字体用实际文件核对。交付重点是导入内容往返保留；引擎自带工具栏操作不封锁，
逐项冒烟并如实记录，未逐项验收的插入、批注、修订操作不声明支持。
```

- [ ] **Step 3: 更新 spec/03 §6 支持范围**

将第 123—124 行"普通段落、标题、列表和简单表格构成首批兼容性基线。文本框、复杂域、修订、复杂合并表格等结构，未验证保留能力时拒绝编辑。页眉页脚、嵌入图片、页码及基础合并单元格先加入往返样本再声明支持。"替换为：

```markdown
普通段落、标题、列表和简单表格构成首批兼容性基线。内容结构不再在编辑器入口拒绝：
图片、页眉页脚、页码、域、修订标记、文本框、批注、脚注/尾注、内容控件、合并表格
（含复杂合并）一律放行，保留能力按验证记录逐类别声明，实测丢失的类别如实降级，不冒充通过。
安全类继续拒绝：宏/ActiveX、OLE/嵌入对象、外部资源与外链模板、`altChunk`、嵌套压缩、加密与超限包。
导出核对口径：正文按同一提取契约精确相等（计入 `w:t`：表格、文本框 Choice 分支、修订插入文字、
域结果；不计入 `w:delText`、moveFrom、`w:instrText`、`mc:Fallback`、页眉页脚/批注/脚注部件文字）；
结构数量导出不得少于编辑快照（图片、修订标记、批注、脚注引用、文本框、合并单元格），
不一致即拒绝提交并保留当前编辑。
```

- [ ] **Step 4: 更新 spec/03 §7 验收表**

在 WD-12 之后新增两行：

```markdown
| WD-13 | 往返样本逐类别（图片、页眉页脚、域、修订标记、文本框、批注、脚注、内容控件、合并表格）经 导入→编辑→导出 后由 Microsoft Word 实际打开核对，结构与文字按预期清单一致，保留/降级结论如实记录 |
| WD-14 | 导出核对拦截静默丢失：正文不一致或结构数量少于编辑快照时拒绝提交、保留编辑、可重试；正常编辑（含删除内容）不误报 |
```

- [ ] **Step 5: 更新 spec/01 §98 检测义务**

在"混合扫描 PDF、关键嵌图、修订标记、文本框和无法可靠读取的复杂结构必须检测并提示"句后补：

```markdown
；检测结果记入解析快照 `coverage`（ParseSnapshot），超出分析覆盖时 `complete` 为 false 并列明类别，
编辑器可显示与分析覆盖分开，不因能显示而宣称已分析。
```

- [ ] **Step 6: 更新 README.md:48 与 tools/contract-review/README.md:223**

`README.md` 第 48 行"宏、加密、外部资源、图片、页眉页脚、域、批注、修订和复杂合并表格按当前范围拒绝。"替换为：

```markdown
宏、加密、外部资源、嵌入对象、altChunk 与嵌套压缩按安全边界拒绝；图片、页眉页脚、域、批注、修订和合并表格可导入并往返保留，文档可正常编辑，保留能力逐类别以验证记录为准。
```

`tools/contract-review/README.md` 第 223 行含"支持 UTF-8 TXT 与通过主应用校验器的基础 DOCX；图片、页眉页脚、域、修订、外链、"的句子：删除其中结构拒绝表述，改为"支持 UTF-8 TXT 与通过主应用校验器的 DOCX；外链、宏、嵌入对象按安全边界拒绝；图片、修订标记、文本框等结构不再拒绝，超出分析覆盖的类别记入解析覆盖并使 `complete` 为 false"，保持该段其余文字不变。

- [ ] **Step 7: 检查并提交**

```powershell
git diff --check
git add spec/03-word-editing.md spec/01-product.md README.md tools/contract-review/README.md
git commit -m "docs: expand DOCX structure support contract"
```

---

### Task 2: structures.ts 结构类型与导出对账（纯函数）

**Files:**
- Create: `src/lib/documents/structures.ts`
- Test: `src/lib/documents/structures.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `DocumentStructures`、`EditorStructureCounts`、`DocxInspection`、`ExportExpectation`、`countComparable`、`compareExport`（Task 3/7/8 依赖）

- [ ] **Step 1: 写失败测试**

`src/lib/documents/structures.test.ts`：

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { countComparable, compareExport, emptyStructures, type DocxInspection, type ExportExpectation } from "./structures"

const structures = (patch: Partial<ReturnType<typeof emptyStructures>> = {}) => ({ ...emptyStructures(), ...patch })

test("WD-14: 导出正文不一致时拒绝并给出既有文案", () => {
  const actual: DocxInspection = { text: "原文", structures: structures() }
  const expected: ExportExpectation = { text: "改文", structures: { images: 0, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }
  assert.throws(() => compareExport(actual, expected), /导出正文与编辑内容不一致/)
})

test("WD-14: 导出结构少于快照时按类别拒绝", () => {
  const expected: ExportExpectation = { text: "正文", structures: { images: 2, revisions: 3, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }
  const actual: DocxInspection = { text: "正文", structures: structures({ images: 1, revisions: { insertions: 1, deletions: 0, moves: 0, formatChanges: 0 } }) }
  assert.throws(() => compareExport(actual, expected), /图片、修订标记未保留/)
})

test("WD-14: 导出数量不减少时不误报（含用户删除内容）", () => {
  const expected: ExportExpectation = { text: "正文", structures: { images: 1, revisions: 1, comments: 1, notes: 1, textboxes: 1, mergedCells: 1 } }
  const actual: DocxInspection = { text: "正文", structures: structures({ images: 2, revisions: { insertions: 1, deletions: 1, moves: 0, formatChanges: 0 }, comments: 1, notes: 1, textboxes: 1, mergedCells: 2 }) }
  assert.doesNotThrow(() => compareExport(actual, expected))
  const edited: ExportExpectation = { text: "正文", structures: { images: 0, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }
  assert.doesNotThrow(() => compareExport({ text: "正文", structures: emptyStructures() }, edited))
})

test("countComparable 汇总四类修订并保留其余类别", () => {
  const counts = countComparable(structures({ images: 2, comments: 1, notes: 3, textboxes: 4, mergedCells: 5, revisions: { insertions: 1, deletions: 2, moves: 3, formatChanges: 4 } }))
  assert.deepEqual(counts, { images: 2, revisions: 10, comments: 1, notes: 3, textboxes: 4, mergedCells: 5 })
})
```

- [ ] **Step 2: 运行确认失败**

```powershell
pnpm exec tsx --test src/lib/documents/structures.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 structures.ts**

```ts
export type DocumentStructures = {
  images: number
  headerFooterRefs: number
  fields: { simple: number; complex: number }
  revisions: { insertions: number; deletions: number; moves: number; formatChanges: number }
  textboxes: number
  comments: number
  notes: number
  contentControls: number
  mergedCells: number
}

export type EditorStructureCounts = {
  images: number
  revisions: number
  comments: number
  notes: number
  textboxes: number
  mergedCells: number
}

export type DocxInspection = { text: string; structures: DocumentStructures }
export type ExportExpectation = { text: string; structures: EditorStructureCounts }

export function emptyStructures(): DocumentStructures {
  return {
    images: 0, headerFooterRefs: 0, fields: { simple: 0, complex: 0 },
    revisions: { insertions: 0, deletions: 0, moves: 0, formatChanges: 0 },
    textboxes: 0, comments: 0, notes: 0, contentControls: 0, mergedCells: 0,
  }
}

export function emptyCounts(): EditorStructureCounts {
  return { images: 0, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 }
}

const labels: Record<keyof EditorStructureCounts, string> = {
  images: "图片", revisions: "修订标记", comments: "批注", notes: "脚注引用", textboxes: "文本框", mergedCells: "合并单元格",
}

export function countComparable(structures: DocumentStructures): EditorStructureCounts {
  return {
    images: structures.images,
    revisions: structures.revisions.insertions + structures.revisions.deletions + structures.revisions.moves + structures.revisions.formatChanges,
    comments: structures.comments,
    notes: structures.notes,
    textboxes: structures.textboxes,
    mergedCells: structures.mergedCells,
  }
}

// 导出字节不得少于编辑快照：少即为导出丢内容。正文按同一提取契约精确相等。
export function compareExport(actual: DocxInspection, expected: ExportExpectation): void {
  if (actual.text !== expected.text) throw new Error("导出正文与编辑内容不一致，此次结果未保存，请重试。")
  const counts = countComparable(actual.structures)
  const lost = (Object.keys(expected.structures) as (keyof EditorStructureCounts)[]).filter(key => counts[key] < expected.structures[key])
  if (lost.length) throw new Error(`导出结果与编辑内容不一致（${lost.map(key => labels[key]).join("、")}未保留），此次结果未保存，请重试。`)
}
```

- [ ] **Step 4: 运行确认通过**

```powershell
pnpm exec tsx --test src/lib/documents/structures.test.ts
```

预期：PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/lib/documents/structures.ts src/lib/documents/structures.test.ts
git commit -m "feat: add DOCX structure inventory types and export parity check"
```

---

### Task 3: docx.ts 结构清单 + 正文契约 + 返回类型

**Files:**
- Modify: `src/lib/documents/docx.ts`（`validateDocxBytes`、有序解析走查）
- Modify: `src/lib/documents/docx.test.ts`（返回类型与新契约用例）
- Modify: `src/lib/documents/docx.worker.ts`、`src/server/documents/parse-worker.ts`（调用点）
- Test: `src/lib/documents/docx.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `DocumentStructures`、`DocxInspection`、`ExportExpectation`、`compareExport`
- Produces: `validateDocxBytes(bytes, expected?): DocxInspection`；`{ text, structures }`（Task 8/9 依赖）

- [ ] **Step 1: 写失败测试（新契约用例）**

在 `src/lib/documents/docx.test.ts` 顶部把 `fixture` 辅助函数扩展为可替换任意部件，并新增下列用例（现有用例随后在 Step 3 同步返回类型）：

```ts
import { emptyCounts } from "./structures"

async function fixture(change?: (files: Record<string, Uint8Array>) => void) {
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  change?.(files)
  return zipSync(files)
}
const documentXml = (files: Record<string, Uint8Array>) => strFromU8(files["word/document.xml"])
const setDocument = (files: Record<string, Uint8Array>, xml: string) => { files["word/document.xml"] = strToU8(xml) }
const withBody = (body: string) => (files: Record<string, Uint8Array>) =>
  setDocument(files, documentXml(files).replace("<w:p/>", body))

test("WD-13: 图片、页眉页脚、域、文本框、合并单元格放行并计入清单", async () => {
  const bytes = await fixture(withBody(
    '<w:p><w:r><w:drawing><w:inline/></w:drawing></w:r></w:p>' +
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> TOC </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>目录结果</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>合并</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'))
  const files = unzipSync(bytes)
  setDocument(files, documentXml(files).replace("<w:tcPr>", '<w:tcPr><w:gridSpan w:val="2"/>'))
  const inspection = validateDocxBytes(zipSync(files))
  assert.equal(inspection.structures.images, 1)
  assert.equal(inspection.structures.fields.complex, 1)
  assert.equal(inspection.structures.mergedCells, 1)
  assert.equal(inspection.text, "目录结果合并")
})

test("WD-13: 修订标记放行；插入计入正文、删除与 moveFrom 不计入", async () => {
  const bytes = await fixture(withBody(
    '<w:p><w:ins w:id="1" w:author="张三"><w:r><w:t>新增</w:t></w:r></w:ins>' +
    '<w:del w:id="2" w:author="张三"><w:r><w:delText>删除</w:delText></w:r></w:del>' +
    '<w:moveFrom w:id="3"><w:r><w:delText>移出</w:delText></w:r></w:moveFrom>' +
    '<w:moveTo w:id="4"><w:r><w:t>移入</w:t></w:r></w:moveTo></w:p>'))
  const inspection = validateDocxBytes(bytes)
  assert.deepEqual(inspection.structures.revisions, { insertions: 1, deletions: 1, moves: 2, formatChanges: 0 })
  assert.equal(inspection.text, "新增移入")
})

test("WD-13: 文本框 Choice/Fallback 双份存储只计一次", async () => {
  const box = '<w:txbxContent><w:p><w:r><w:t>框内文字</w:t></w:r></w:p></w:txbxContent>'
  const bytes = await fixture(withBody(
    `<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" Requires="wps"><w:drawing><w:txbx>${box}</w:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox>${box}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`))
  const inspection = validateDocxBytes(bytes)
  assert.equal(inspection.structures.textboxes, 1)
  assert.equal(inspection.structures.images, 1)
  assert.equal(inspection.text, "框内文字")
})

test("WD-13: 简单域、页眉页脚、批注、脚注、内容控件放行并计入清单", async () => {
  const bytes = await fixture(files => {
    withBody(
      '<w:p><w:sdt><w:sdtContent><w:r><w:t>控件</w:t></w:r></w:sdtContent></w:sdt>' +
      '<w:r><w:commentReference w:id="1"/></w:r><w:r><w:footnoteReference w:id="2"/></w:r>' +
      '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>' +
      '<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/></w:sectPr></w:pPr></w:r></w:p>')(files)
    files["word/header1.xml"] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:r><w:t>页眉文字</w:t></w:r></w:p></w:hdr>')
  })
  const inspection = validateDocxBytes(bytes)
  assert.equal(inspection.structures.contentControls, 1)
  assert.equal(inspection.structures.comments, 1)
  assert.equal(inspection.structures.notes, 1)
  assert.equal(inspection.structures.fields.simple, 1)
  assert.equal(inspection.structures.headerFooterRefs, 2)
  assert.equal(inspection.text.includes("页眉文字"), false)
  assert.equal(inspection.text.includes("控件1"), true)
})

test("WD-14: expected 传入时执行正文与结构对账", async () => {
  const bytes = await fixture(withBody('<w:p><w:r><w:drawing><w:inline/></w:drawing></w:r><w:r><w:t>正文</w:t></w:r></w:p>'))
  assert.throws(() => validateDocxBytes(bytes, { text: "别的", structures: { images: 0, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }), /导出正文与编辑内容不一致/)
  assert.throws(() => validateDocxBytes(bytes, { text: "正文", structures: { images: 2, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }), /图片未保留/)
  assert.doesNotThrow(() => validateDocxBytes(bytes, { text: "正文", structures: { images: 1, revisions: 0, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 } }))
})

test("WD-09: 安全拒绝保持不变（宏、外链、嵌套压缩、altChunk、object）", async () => {
  const bytes = await fixture(withBody('<w:p><w:altChunk r:id="rIdA"/></w:p>'))
  assert.throws(() => validateDocxBytes(bytes), /嵌入内容|暂不支持|外部资源|无效/)
  const objectBytes = await fixture(withBody('<w:p><w:object/></w:p>'))
  assert.throws(() => validateDocxBytes(objectBytes), /嵌入内容|暂不支持|外部资源|无效/)
})
```

注：`altChunk`/`object` 的既有拒绝走关系与包名校验；若夹具未触发既有拒绝分支，按 `docx.ts` 现有 `invalid` 文案断言 `/嵌入内容/`，并在实现中把 `altChunk`、`object` 显式并入安全拒绝列表（错误信息"不支持外部模板或嵌入内容。"）。

- [ ] **Step 2: 运行确认失败**

```powershell
pnpm exec tsx --test src/lib/documents/docx.test.ts
```

预期：新用例 FAIL（返回字符串而非对象、结构仍被拒绝）。

- [ ] **Step 3: 重写 docx.ts 校验与提取**

将 `validateDocxBytes` 的返回类型与正文/结构提取部分替换为：

```ts
import { compareExport, emptyStructures, type DocxInspection, type ExportExpectation } from "./structures"

type OrderedNode = Record<string, unknown>

// preserveOrder 输出中属性在 ":@"，文本在 "#text"；Fallback 子树跳过防文本框 Choice/Fallback 双计。
function walkOrdered(nodes: unknown[], onElement: (key: string, attrs: Record<string, string>, children: unknown[]) => void) {
  if (!Array.isArray(nodes)) return
  for (const node of nodes as OrderedNode[]) {
    const attrs = (node[":@"] ?? {}) as Record<string, string>
    for (const [key, value] of Object.entries(node)) {
      if (key === ":@" || key === "#text") continue
      const children = Array.isArray(value) ? value : []
      onElement(key, attrs, children)
      if (key !== "Fallback") walkOrdered(children, onElement)
    }
  }
}

function textOf(children: unknown[]): string {
  let out = ""
  for (const node of children as OrderedNode[]) for (const [key, value] of Object.entries(node)) {
    if (key === "#text") out += String(value)
    else if (Array.isArray(value)) out += textOf(value)
  }
  return out
}

function countElement(key: string, attrs: Record<string, string>, structures: ReturnType<typeof emptyStructures>) {
  const field = (name: string) => attrs[`@_${name}`] ?? attrs[`@_w:${name}`]
  if (key === "drawing" || key === "pict") structures.images++
  if (key === "headerReference" || key === "footerReference") structures.headerFooterRefs++
  if (key === "fldSimple") structures.fields.simple++
  if (key === "fldChar" && field("fldCharType") === "begin") structures.fields.complex++
  if (key === "ins") structures.revisions.insertions++
  if (key === "del") structures.revisions.deletions++
  if (key === "moveFrom" || key === "moveTo") structures.revisions.moves++
  if (/PrChange$/.test(key)) structures.revisions.formatChanges++
  if (key === "txbxContent") structures.textboxes++
  if (key === "commentReference") structures.comments++
  if (key === "footnoteReference" || key === "endnoteReference") structures.notes++
  if (key === "sdt") structures.contentControls++
  if (key === "gridSpan" || key === "vMerge") structures.mergedCells++
}
```

`validateDocxBytes` 主体改造（保留包目录、CRC、外链、实体、宏等既有检查不动）：

```ts
export function validateDocxBytes(bytes: Uint8Array, expected?: ExportExpectation): DocxInspection {
  // …既有 size/directory/unzip/XML 校验、typesValid/documentValid/rootRelationship 判定全部保留…
  const structures = emptyStructures()
  let bodyText = ""
  for (const [name, text] of xmlFiles) {
    // …既有 DOCTYPE/ENTITY、Content_Types、.rels 校验全部保留…
    if (/^word\/.*\.xml$/i.test(name)) {
      const ordered = new XMLParser({ preserveOrder: true, ignoreAttributes: false, removeNSPrefix: true, processEntities: true, parseTagValue: false, trimValues: false }).parse(text)
      walkOrdered(ordered, (key, attrs, children) => {
        countElement(key, attrs, structures)
        if (name === "word/document.xml" && key === "t") bodyText += textOf(children)
      })
    }
  }
  if (!typesValid || !documentValid || !rootRelationship) throw invalid()
  const inspection = { text: bodyText, structures }
  if (expected) compareExport(inspection, expected)
  return inspection
}
```

同时在关系校验中把 `altChunk`、`object` 归入安全拒绝：

```ts
if (/attachedTemplate|oleObject|aFChunk|altChunk/i.test(String(relation?.["@_Type"]))) throw invalid("不支持外部模板或嵌入内容。")
```

并在 word 部件走查中删除原 175 行结构拒绝整体分支。若 `object`、`altChunk` 作为元素出现但无对应关系，保留一条显式检查：

```ts
if (key === "altChunk" || key === "object") throw invalid("不支持外部模板或嵌入内容。")
```

- [ ] **Step 4: 更新调用点与现有测试的返回用法**

`src/lib/documents/docx.worker.ts`：

```ts
import { prepareDocxBytes, validateDocxBytes } from "./docx"
import type { ExportExpectation } from "./structures"

self.onmessage = (event: MessageEvent<{ bytes: ArrayBuffer; prepare: boolean; expected?: ExportExpectation }>) => {
  try {
    const bytes = new Uint8Array(event.data.bytes)
    validateDocxBytes(bytes, event.data.expected)
    const prepared = event.data.prepare ? prepareDocxBytes(bytes) : undefined
    self.postMessage({ ok: true, bytes: prepared?.buffer }, prepared ? [prepared.buffer] : [])
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : "DOCX 校验失败。" })
  }
}
```

（以文件现有实现为准做最小改动：仅把 `expectedText` 换成 `expected` 并传入。）

`src/lib/documents/docx.test.ts` 现有用例更新返回用法：`validateDocxBytes(bytes, " 001.00 & 甲方 三十日")` → `validateDocxBytes(bytes, { text: " 001.00 & 甲方 三十日", structures: emptyCounts() }).text`；断言返回值处改 `.text`；"reject macros… unverified features" 用例中 `ins`、`del`、`txbxContent`、`instrText`、`gridSpan`、`drawing` 不再拒绝——改为断言 `validateDocxBytes` 不抛出，保留 `word/vbaProject.bin`、`../outside.xml`、`word/embeddings/test.docx`、`word/data.zip` 的拒绝断言，并为 `altChunk`、`object` 补拒绝断言（Step 1 已含）。

`src/server/documents/parse-worker.ts` 仅需适配返回类型（忽略返回值即可，编译不报错则不改）。

- [ ] **Step 5: 运行全部文档测试**

```powershell
pnpm exec tsx --test src/lib/documents/*.test.ts
```

预期：PASS（结构放行、清单计数、Fallback 去重、修订语义、安全拒绝回归全绿）。

- [ ] **Step 6: 提交**

```powershell
git add src/lib/documents/docx.ts src/lib/documents/docx.test.ts src/lib/documents/docx.worker.ts src/server/documents/parse-worker.ts
git commit -m "feat: accept DOCX content structures with inventory instead of rejection"
```

---

### Task 4: structure-fixtures.ts 合成往返样本构建器

**Files:**
- Create: `src/lib/documents/structure-fixtures.ts`
- Test: `src/lib/documents/structure-fixtures.test.ts`

**Interfaces:**
- Consumes: `blankDocx`、`validateDocxBytes`、`DocumentStructures`
- Produces: `structureFixtures: StructureFixture[]`，每项 `{ id, title, build(): Uint8Array, expected: { text: string; structures: DocumentStructures; word: WordExpectation } }`；`WordExpectation`（Task 5/10 依赖）：

```ts
export type WordExpectation = {
  bodyContains: string[]
  headerContains: string[]
  revisions?: number
  inlineShapesMin?: number
  shapesMin?: number
  fieldsMin?: number
  tables?: number
  footnotesMin?: number
}
```

- [ ] **Step 1: 写失败测试**

`src/lib/documents/structure-fixtures.test.ts`：

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { validateDocxBytes } from "./docx"
import { structureFixtures } from "./structure-fixtures"

test("WD-13: 每个往返样本通过校验且清单与预期一致", () => {
  const ids = structureFixtures.map(item => item.id)
  assert.ok(ids.length >= 12)
  assert.equal(new Set(ids).size, ids.length)
  for (const fixture of structureFixtures) {
    const inspection = validateDocxBytes(fixture.build())
    assert.deepEqual(inspection.structures, fixture.expected.structures, fixture.id)
    assert.equal(inspection.text, fixture.expected.text, fixture.id)
  }
})

test("WD-13: 样本覆盖全部结构类别", () => {
  const totals = structureFixtures.reduce((sum, item) => ({
    images: sum.images + item.expected.structures.images,
    revisions: sum.revisions + item.expected.structures.revisions.insertions + item.expected.structures.revisions.deletions + item.expected.structures.revisions.moves + item.expected.structures.revisions.formatChanges,
    textboxes: sum.textboxes + item.expected.structures.textboxes,
    mergedCells: sum.mergedCells + item.expected.structures.mergedCells,
    notes: sum.notes + item.expected.structures.notes,
    comments: sum.comments + item.expected.structures.comments,
  }), { images: 0, revisions: 0, textboxes: 0, mergedCells: 0, notes: 0, comments: 0 })
  for (const [key, value] of Object.entries(totals)) assert.ok(value > 0, `${key} 缺少样本`)
})
```

- [ ] **Step 2: 运行确认失败**

```powershell
pnpm exec tsx --test src/lib/documents/structure-fixtures.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 structure-fixtures.ts**

以 `blankDocx()` 的包为底、替换 `word/document.xml` 正文并按需增补部件。至少实现下列样本（id 固定）：

| id | 内容 | 重点 |
| --- | --- | --- |
| `image-inline` | 行内 `w:drawing`（占位 PNG 1×1，最小 base64） | 图片保留 |
| `image-floating` | 浮动 `w:drawing`（`wp:anchor`）+ 环绕 | 浮动图保留 |
| `header-footer` | 页眉文字 + 页脚文字 + `w:headerReference`/`w:footerReference` + header/footer 部件 | 页眉页脚保留 |
| `field-page` | `w:fldSimple PAGE` + `w:fldSimple NUMPAGES` + 页码 | 简单域保留 |
| `field-toc` | `w:fldChar`+`w:instrText TOC`+结果文字 | 复杂域保留 |
| `textbox-drawingml` | `mc:AlternateContent` Choice/Fallback 文本框（含双份存储） | 文本框保留 + 去重 |
| `textbox-vml` | 独立 `w:pict`/`v:textbox` 文本框 | VML 文本框保留 |
| `comments` | `commentRangeStart/End`+`commentReference`+`word/comments.xml` | 批注保留 |
| `footnotes` | `footnoteReference`+`word/footnotes.xml` | 脚注保留 |
| `content-control` | `w:sdt` 块级与行内 | 内容控件保留 |
| `table-merge` | `gridSpan`+`vMerge` 复杂合并表格 | 合并单元格保留 |
| `revisions-all` | `ins`/`del`/`rPrChange`/`moveFrom`/`moveTo`（作者、时间齐全） | 修订标记保留 |
| `contract-full` | 房建机电安装分包合同综合样本（标题样式、条款、表格、页眉页脚、页码、行内图、修订各一） | 综合往返 |

实现骨架（每个样本一个构建函数，公共装配统一走 `assemble`）：

第一步先在 `docx.ts` 抽出同步构建器（`blankDocx()` 复用它）：

```ts
// docx.ts 新增导出
export function blankDocxFiles(): Record<string, Uint8Array> {
  // 原 blankDocx() 内的 files 对象构造原样搬入并 return files
}
export function blankDocx(): Blob {
  return new Blob([prepareDocxBytes(zipSync(blankDocxFiles())) as Uint8Array<ArrayBuffer>], { type: DOCX_TYPE })
}
```

`structure-fixtures.ts` 骨架：

```ts
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { blankDocxFiles } from "./docx"
import { emptyStructures, type DocumentStructures } from "./structures"

export type WordExpectation = {
  bodyContains: string[]
  headerContains: string[]
  revisions?: number
  inlineShapesMin?: number
  shapesMin?: number
  fieldsMin?: number
  tables?: number
  footnotesMin?: number
}

export type StructureFixture = {
  id: string
  title: string
  build: () => Uint8Array
  expected: { text: string; structures: DocumentStructures; word: WordExpectation }
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

function assemble(change: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = blankDocxFiles()
  change(files)
  return zipSync(files)
}

// 每个样本一个导出常量，形如：
const imageInline: StructureFixture = {
  id: "image-inline",
  title: "行内图片",
  build: () => assemble(files => {
    const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg1" Type="${R}/image" Target="media/image1.png"/></Relationships>`
    files["word/_rels/document.xml.rels"] = strToU8(rels)
    files["word/media/image1.png"] = Uint8Array.from(Buffer.from(PNG, "base64"))
    files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>",
      '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rIdImg1"/></wp:inline></w:drawing></w:r></w:p>'))
  }),
  expected: {
    text: "",
    structures: { ...emptyStructures(), images: 1 },
    word: { bodyContains: [], headerContains: [], inlineShapesMin: 1 },
  },
}

export const structureFixtures: StructureFixture[] = [imageInline, /* 其余 12 个样本逐一按上表 id/内容/重点实现，每个都写全 build() 与 expected */]
```

实现要求（写死在代码里，不留待填）：
- 每个样本把 `expected.structures` 按 `emptyStructures()` 填实（图片数、修订数、合并数等与 XML 一一对应），`expected.text` 是按正文契约应提取的文字。
- 新增部件（header1.xml、comments.xml、footnotes.xml）须同步补 `[Content_Types].xml` Override 与 `word/_rels/document.xml.rels` 关系，否则 Task 3 校验会拒绝。
- `expected.word` 按 Task 10 的 COM 检查字段填实（如 `revisions-all` 填 `revisions: 5`、`contract-full` 填 `inlineShapesMin: 1`、`headerContains: ["某某建设集团有限公司"]` 等）。

- [ ] **Step 4: 运行确认通过**

```powershell
pnpm exec tsx --test src/lib/documents/structure-fixtures.test.ts
```

预期：PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/lib/documents/structure-fixtures.ts src/lib/documents/structure-fixtures.test.ts src/lib/documents/docx.ts
git commit -m "feat: add synthetic DOCX structure round-trip fixtures"
```

（若 Step 3 抽取了 `blankDocxFiles`，`docx.ts` 一并提交。）

---

### Task 5: 夹具落盘脚本与 npm scripts

**Files:**
- Create: `scripts/docx-structure-fixtures.mts`
- Modify: `package.json`（scripts）

**Interfaces:**
- Consumes: Task 4 `structureFixtures`
- Produces: `.superpowers/previews/word-structures/*.docx` + `manifest.json`（Task 6/10 依赖）

- [ ] **Step 1: 实现落盘脚本**

`scripts/docx-structure-fixtures.mts`：

```ts
import { mkdirSync, writeFileSync } from "node:fs"
import { structureFixtures } from "../src/lib/documents/structure-fixtures"

const directory = ".superpowers/previews/word-structures"
mkdirSync(`${directory}/engine`, { recursive: true })
const manifest = structureFixtures.map(item => {
  const bytes = item.build()
  writeFileSync(`${directory}/${item.id}.docx`, bytes)
  return { id: item.id, title: item.title, file: `${item.id}.docx`, expect: item.expected.word, expectedStructures: item.expected.structures, expectedText: item.expected.text }
})
writeFileSync(`${directory}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Structure fixtures: ${directory} (${manifest.length} files)`)
```

- [ ] **Step 2: package.json 增加 scripts**

在 `scripts` 中加入：

```json
"fixtures:structures": "tsx scripts/docx-structure-fixtures.mts",
"roundtrip:engine": "tsx scripts/roundtrip/engine-roundtrip.mts",
"roundtrip:word": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/roundtrip/verify-word.ps1",
"roundtrip": "pnpm fixtures:structures && pnpm roundtrip:engine && pnpm roundtrip:word"
```

- [ ] **Step 3: 运行并核对输出**

```powershell
pnpm fixtures:structures
```

预期：输出 `Structure fixtures: .superpowers/previews/word-structures (13 files)`；目录含 13 个 `.docx` 与 `manifest.json`；`manifest.json` 每项含 `expect`、`expectedStructures`、`expectedText`。

- [ ] **Step 4: 提交**

```powershell
git add scripts/docx-structure-fixtures.mts package.json
git commit -m "feat: write DOCX structure fixtures and manifest for round-trip checks"
```

---

### Task 6: 引擎往返 harness（验证页 + 浏览器驱动脚本）

**Files:**
- Create: `src/app/dev/roundtrip/page.tsx`
- Create: `src/components/roundtrip-harness.tsx`
- Modify: `src/components/word-canvas.tsx`（`WordCanvasHandle` 增加 `snapshot()`）
- Create: `scripts/roundtrip/engine-roundtrip.mts`
- Modify: `package.json`（devDependency `playwright-core`）

**Interfaces:**
- Consumes: Task 5 夹具目录；`WordCanvas` 现有 `serialize()`
- Produces: `window.__roundtrip` API；`.superpowers/previews/word-structures/engine/*`（导出 DOCX + 引擎 JSON）与 `engine-report.json`（Task 7 校准、Task 10 证据依赖）

- [ ] **Step 1: WordCanvasHandle 增加 snapshot**

`src/components/word-canvas.tsx`：`export type WordCanvasHandle = { serialize: () => Promise<Blob>; snapshot: () => unknown }`，在 effect 内构造的 `session` 上补：

```ts
snapshot() {
  if (disposed || !load.isCurrent() || !ready || engine.current !== session || !instance?.activeEditor) {
    throw new Error("文档尚未就绪。")
  }
  return structuredClone(instance.activeEditor.getJSON())
}
```

并在 `useImperativeHandle` 暴露 `snapshot: () => { if (!engine.current) throw new Error("文档尚未就绪。"); return engine.current.snapshot() }`。

- [ ] **Step 2: 验证页（环境变量门禁）**

`src/app/dev/roundtrip/page.tsx`：

```tsx
import { notFound } from "next/navigation"
import { RoundtripHarness } from "@/components/roundtrip-harness"

export const dynamic = "force-dynamic"

export default function Page() {
  if (process.env.EQUILENS_ROUNDRIP_HARNESS !== "1") notFound()
  return <RoundtripHarness />
}
```

`src/components/roundtrip-harness.tsx`（"use client"）：文件输入 + 就绪状态 + 两个按钮（导出/快照）与最小实现；同时把 API 挂到 `window.__roundtrip` 供脚本调用：

```ts
export type RoundtripCapture = { json: unknown; base64?: string; error?: string }
export type RoundtripApi = {
  ready: () => boolean
  capture: () => Promise<RoundtripCapture>
}
declare global { interface Window { __roundtrip?: RoundtripApi } }
```

组件内部用 `useRef<WordCanvasHandle>` 调 `snapshot()` 与 `serialize()`；`capture()` 先取 `snapshot()` 再 `serialize()` 并把 Blob 转 base64；任一步失败把错误文本放进 `capture` 返回值 `{ error }` 也要输出（引擎 JSON 仍须返回，校准不被导出失败阻塞）。就绪判定用 `WordCanvas` 的 `onStateChange` 状态 === "ready"。界面只用官方 shadcn `Button`、`Input`，无装饰文案。

- [ ] **Step 3: 安装 playwright-core（精确版本）**

```powershell
npm view playwright-core version
pnpm add -D playwright-core@<上一步输出的精确版本>
```

不使用 `^`/`~` 范围；不下载浏览器（用本机 Edge）。

- [ ] **Step 4: 实现 engine-roundtrip.mts**

`scripts/roundtrip/engine-roundtrip.mts` 要点（完整实现按此写出）：

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { chromium } from "playwright-core"

const base = process.env.EQUILENS_BASE_URL ?? "http://127.0.0.1:3000"
const directory = ".superpowers/previews/word-structures"
const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8")) as Array<{ id: string }>
const browser = await chromium.launch({ channel: "msedge", headless: true })
const page = await browser.newPage()
const report: Array<{ id: string; ok: boolean; error?: string }> = []
for (const item of manifest) {
  try {
    await page.goto(`${base}/dev/roundtrip`)
    await page.setInputFiles('input[type="file"]', `${directory}/${item.id}.docx`)
    await page.waitForFunction(() => window.__roundtrip?.ready() === true, undefined, { timeout: 60000 })
    const captured = await page.evaluate(() => window.__roundtrip!.capture())
    writeFileSync(`${directory}/engine/${item.id}.json`, JSON.stringify(captured.json, null, 2))
    if (captured.base64) writeFileSync(`${directory}/engine/${item.id}.export.docx`, Buffer.from(captured.base64, "base64"))
    report.push({ id: item.id, ok: Boolean(captured.base64), ...(captured.error ? { error: captured.error } : {}) })
  } catch (error) {
    report.push({ id: item.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
writeFileSync(`${directory}/engine-report.json`, `${JSON.stringify(report, null, 2)}\n`)
await browser.close()
console.log(`Engine round-trip: ${report.filter(item => item.ok).length}/${report.length} exported`)
```

（`capture()` 的错误返回结构与 `RoundtripApi` 类型在实现时对齐：`capture(): Promise<{ json: unknown; base64?: string; error?: string }>`，类型以 harness 导出为准，两处保持一致。）

- [ ] **Step 5: 运行 harness 与脚本**

```powershell
# 终端 1（后台）
$env:EQUILENS_ROUNDRIP_HARNESS="1"; pnpm dev
# 终端 2
pnpm roundtrip:engine
```

预期：`engine-report.json` 有 13 条记录；`engine/` 下有 13 个 `.json` 快照；导出成功的条目有 `.export.docx`。首次运行允许 `error` 存在于修订/文本框样本（校准未做），但每条必须留下 JSON 快照。

- [ ] **Step 6: 提交**

```powershell
git add src/app/dev/roundtrip/page.tsx src/components/roundtrip-harness.tsx src/components/word-canvas.tsx scripts/roundtrip/engine-roundtrip.mts package.json pnpm-lock.yaml
git commit -m "feat: add engine round-trip harness for structure verification"
```

---

### Task 7: editorText / editorStructures 校准（引擎 JSON 为夹具）

**Files:**
- Modify: `src/lib/documents/serialize.ts`（`editorText` 扩展 + 新增 `editorStructures`）
- Create: `src/lib/documents/calibration/`（从 `engine/*.json` 挑选的最小样本）
- Test: `src/lib/documents/serialize.test.ts`（新增校准用例）

**Interfaces:**
- Consumes: Task 6 生成的 `engine/*.json` 与 `manifest.json` 的 `expectedText`/`expectedStructures`
- Produces: `editorText(value: unknown): string`、`editorStructures(value: unknown): EditorStructureCounts`（Task 8 依赖）

- [ ] **Step 1: 观察引擎 JSON 节点类型**

```powershell
Select-String -Path ".superpowers/previews/word-structures/engine/revisions-all.json",".superpowers/previews/word-structures/engine/textbox-drawingml.json",".superpowers/previews/word-structures/engine/footnotes.json",".superpowers/previews/word-structures/engine/comments.json",".superpowers/previews/word-structures/engine/table-merge.json" -Pattern '"type": "[^"]+"' | ForEach-Object { $_.Matches.Value } | Sort-Object -Unique
```

记录输出的 `type` 取值（如 `trackInsert`/`trackDelete`/`image`/`footnote` 等），以及 `tableCell` 的 `attrs`（`gridSpan`/`rowspan`/`vMerge` 的实际键名）、删除内容的承载方式（独立节点还是 `marks`）。

- [ ] **Step 2: 写失败校准测试**

把 `revisions-all`、`textbox-drawingml`、`footnotes`、`comments`、`table-merge` 五个样本的引擎 JSON 精简复制到 `src/lib/documents/calibration/<id>.json`（删除与文字/结构无关的大段样式属性，保留 type/content/attrs/marks 骨架），`serialize.test.ts` 新增：

```ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { editorStructures, editorText } from "./serialize"

const sample = (id: string) => JSON.parse(readFileSync(resolve(__dirname, "calibration", `${id}.json`), "utf8"))

test("校准: 修订样本正文不含删除文字、结构计数与清单一致", () => {
  const json = sample("revisions-all")
  assert.equal(editorText(json).includes("删除"), false)
  assert.equal(editorText(json).includes("新增"), true)
  assert.equal(editorStructures(json).revisions, 5)
})

test("校准: 文本框、脚注、批注、合并单元格计数", () => {
  assert.equal(editorStructures(sample("textbox-drawingml")).textboxes, 1)
  assert.equal(editorText(sample("textbox-drawingml")), "框内文字")
  assert.equal(editorStructures(sample("footnotes")).notes, 1)
  assert.equal(editorStructures(sample("comments")).comments, 1)
  assert.equal(editorStructures(sample("table-merge")).mergedCells, 3)
})
```

（期望数字以 Task 4 夹具的 `expected.structures` 为准，两者必须一致。）

- [ ] **Step 3: 运行确认失败**

```powershell
pnpm exec tsx --test src/lib/documents/serialize.test.ts
```

预期：FAIL。

- [ ] **Step 4: 实现分类规则并扩展 serialize.ts**

```ts
// 节点分类以 src/lib/documents/calibration/ 的 superdoc@1.47.2 样本为夹具。
// 规则可按实测类型名调整，但必须让校准测试全绿后才能提交。
function categoryOf(type: string): "deleted" | "image" | "revision" | "comment" | "note" | "textbox" | "content" {
  if (/delete|moveFrom/i.test(type)) return "deleted"
  if (/image|picture/i.test(type)) return "image"
  if (/track|revision/i.test(type)) return "revision"
  if (/comment/i.test(type)) return "comment"
  if (/footnote|endnote/i.test(type)) return "note"
  if (/text.?box/i.test(type)) return "textbox"
  return "content"
}

const deletedMark = (marks: unknown): boolean =>
  Array.isArray(marks) && marks.some(mark => /delete|moveFrom/i.test(String((mark as { type?: string })?.type ?? "")))

export function editorText(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  const node = value as { type?: string; text?: string; marks?: unknown; content?: unknown[] }
  if (node.type === "text") return deletedMark(node.marks) ? "" : node.text ?? ""
  const category = categoryOf(node.type ?? "")
  if (category === "deleted" || category === "comment" || category === "note") return ""
  return node.content?.map(editorText).join("") ?? ""
}

export function editorStructures(value: unknown): EditorStructureCounts {
  const counts = emptyCounts()
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return
    const item = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }
    const category = categoryOf(item.type ?? "")
    if (category === "image") counts.images++
    if (category === "revision" || category === "deleted") counts.revisions++
    if (category === "comment") counts.comments++
    if (category === "note") counts.notes++
    if (category === "textbox") counts.textboxes++
    if (item.type === "tableCell") {
      const attrs = item.attrs ?? {}
      const span = Number(attrs.gridSpan ?? attrs.colspan ?? 1)
      if (span > 1 || attrs.vMerge || attrs.rowspan !== undefined) counts.mergedCells++
    }
    item.content?.forEach(walk)
  }
  walk(value)
  return counts
}
```

`editorStructures` 引入 `emptyCounts` 从 `./structures` 导入。若校准显示删除内容以 `trackDelete` 节点承载、`trackInsert` 存在等，按 Step 1 观察结果核对分类命中（`trackDelete` 命中 `deleted`、`trackInsert` 命中 `revision`）。

- [ ] **Step 5: 运行确认通过（含回归）**

```powershell
pnpm exec tsx --test src/lib/documents/serialize.test.ts src/lib/documents/*.test.ts
```

预期：PASS；现有 `editorText` 用例不回归。

- [ ] **Step 6: 提交**

```powershell
git add src/lib/documents/serialize.ts src/lib/documents/serialize.test.ts src/lib/documents/calibration
git commit -m "feat: align editor text and structure counting with engine document model"
```

---

### Task 8: 导出对账接线（validate.ts / docx.worker.ts / word-canvas.tsx）

**Files:**
- Modify: `src/lib/documents/validate.ts`
- Modify: `src/lib/documents/docx.worker.ts`
- Modify: `src/components/word-canvas.tsx`（serialize 流程）
- Test: `src/lib/documents/validate.test.ts`（新增；若不存在）

**Interfaces:**
- Consumes: Task 2 `ExportExpectation`、Task 3 `validateDocxBytes`、Task 7 `editorText`/`editorStructures`
- Produces: 保存/导出链路的结构对账；`validateDocx(blob, signal?, prepare?, expected?)`

- [ ] **Step 1: 写失败测试**

`src/lib/documents/validate.test.ts`（用 fake Worker 环境不可行则测纯函数接线，浏览器链路由 Task 10 全套运行覆盖）：

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { compareExport, emptyStructures } from "./structures"
import { editorStructures, editorText } from "./serialize"

test("WD-14: 快照派生的期望对象驱动对账", () => {
  const snapshot = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "正文" }, { type: "image" }] },
    { type: "paragraph", content: [{ type: "trackDelete", content: [{ type: "text", text: "删除" }] }] },
  ] }
  const expected = { text: editorText(snapshot), structures: editorStructures(snapshot) }
  assert.equal(expected.text, "正文")
  assert.deepEqual(expected.structures, { images: 1, revisions: 1, comments: 0, notes: 0, textboxes: 0, mergedCells: 0 })
  const actual = { text: "正文", structures: { ...emptyStructures(), images: 1, revisions: { insertions: 0, deletions: 1, moves: 0, formatChanges: 0 } } }
  assert.doesNotThrow(() => compareExport(actual, expected))
})
```

- [ ] **Step 2: 运行确认失败**

```powershell
pnpm exec tsx --test src/lib/documents/validate.test.ts
```

预期：FAIL（`editorStructures` 不在 `serialize.ts` 时为编译错；若 Task 7 已实现则此测应过，把此步视为接线自查）。

- [ ] **Step 3: 接线**

`src/lib/documents/validate.ts`：

```ts
export async function validateDocx(blob: Blob, signal?: AbortSignal, prepare = false, expected?: ExportExpectation): Promise<Blob> {
  // …既有大小检查、Worker、超时、中止全部保留…
  worker.postMessage({ bytes, prepare, expected }, [bytes])
}
```

`src/lib/documents/docx.worker.ts`：消息类型改为 `{ bytes: ArrayBuffer; prepare: boolean; expected?: ExportExpectation }`，`validateDocxBytes(bytes, event.data.expected)`。

`src/components/word-canvas.tsx` serialize 内：

```ts
const snapshot = structuredClone(editor.getJSON())
const expected = { text: editorText(snapshot), structures: editorStructures(snapshot) }
const editable = editor.isEditable
editor.setEditable(false, false)
try {
  const before = errors
  const blob = await currentInstance.export({ exportType: ["docx"], triggerDownload: false })
  if (!current()) throw new Error("操作已取消。")
  if (errors !== before || !blob?.size) throw new Error("Word 文档导出失败，当前编辑已保留，请重试。")
  if (!ready) throw new Error("操作已取消。")
  if (editorText(editor.getJSON()) !== expected.text) throw new Error("导出过程改变了编辑内容，此次结果未保存，请重试。")
  await validateDocx(blob, load.signal, false, expected)
  // …既有 current/ready 复查、失败恢复、setEditable 还原全部保留…
```

- [ ] **Step 4: 运行测试与静态检查**

```powershell
pnpm exec tsx --test src/lib/documents/*.test.ts
pnpm check
```

预期：PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/lib/documents/validate.ts src/lib/documents/docx.worker.ts src/components/word-canvas.tsx src/lib/documents/validate.test.ts
git commit -m "feat: enforce export structure parity against the edit snapshot"
```

---

### Task 9: 分析覆盖（parseDocxBytes / ParseSnapshot / runner）

**Files:**
- Modify: `tools/contract-review/src/types.ts`（`ParseCoverage`）
- Modify: `tools/contract-review/src/document.ts`（`parseDocxBytes`、`readDocxInChild`、`parseDocument`、`coverageComplete`）
- Modify: `tools/contract-review/src/document-worker.ts`（消息带 coverage）
- Modify: `src/server/contract-review/tasks/repository.ts`（`ParseSnapshot`）、`runner.ts`（complete 语义）
- Test: `tools/contract-review/tests/document.test.ts`

**Interfaces:**
- Consumes: Task 3 `validateDocxBytes` 返回的 `structures`
- Produces: `ParseCoverage`、`coverageComplete(coverage): boolean`、`parseDocxBytes(bytes): { paragraphs, coverage }`、`readDocxInChild(...): Promise<{ paragraphs, coverage }>`

- [ ] **Step 1: 写失败测试（覆盖替代拒绝）**

`tools/contract-review/tests/document.test.ts` 中把"AC-24：修订、嵌套表格和不支持扩展名明确拒绝"用例替换为：

```ts
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { structureFixtures } from "../../../src/lib/documents/structure-fixtures"

test("AC-24: 修订与复杂结构不再拒绝，覆盖记入 coverage 且 complete 为 false", async () => {
  const revisionFixture = structureFixtures.find(item => item.id === "revisions-all")
  assert.ok(revisionFixture)
  const parsedRevision = parseDocxBytes(revisionFixture.build())
  assert.equal(parsedRevision.coverage.revisions > 0, true)
  assert.equal(coverageComplete(parsedRevision.coverage), false)

  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>",
    "<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>嵌套</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>"))
  const parsedNested = parseDocxBytes(zipSync(files))
  assert.equal(parsedNested.coverage.complex > 0, true)
  assert.throws(() => parseDocxBytes(new Uint8Array([1, 2, 3])))
  assert.throws(() => parseDocxBytes(Buffer.from("<xml/>")))
  await assert.rejects(parseDocument("synthetic.pdf"), { code: "REVIEW_DOCUMENT_INVALID" })
})

test("AC-24: 文本框样本解析正文不双计且 complete 为 false", () => {
  const textboxFixture = structureFixtures.find(item => item.id === "textbox-drawingml")
  assert.ok(textboxFixture)
  const parsed = parseDocxBytes(textboxFixture.build())
  assert.equal(parsed.paragraphs.map(item => item.text).join(""), "框内文字")
  assert.equal(parsed.coverage.textboxes, 1)
  assert.equal(coverageComplete(parsed.coverage), false)
})
```

（沿用该测试文件现有 `blankDocx` 导入与构造风格；`structureFixtures` 引入 Task 4 的样本构建器。）

- [ ] **Step 2: 运行确认失败**

```powershell
pnpm test:contract
```

预期：FAIL。

- [ ] **Step 3: 实现 coverage**

`tools/contract-review/src/types.ts` 增加：

```ts
export type ParseCoverage = { images: number; revisions: number; textboxes: number; complex: number }
```

`tools/contract-review/src/document.ts`：

```ts
import { validateDocxBytes } from "../../../src/lib/documents/docx"
import type { ParseCoverage } from "./types"

export function coverageComplete(coverage: ParseCoverage): boolean {
  return coverage.images === 0 && coverage.revisions === 0 && coverage.textboxes === 0 && coverage.complex === 0
}

export function parseDocxBytes(bytes: Uint8Array): { paragraphs: Paragraph[]; coverage: ParseCoverage } {
  const { structures } = validateDocxBytes(bytes)
  const coverage: ParseCoverage = {
    images: structures.images,
    revisions: structures.revisions.insertions + structures.revisions.deletions + structures.revisions.moves + structures.revisions.formatChanges,
    textboxes: structures.textboxes,
    complex: 0,
  }
  // …后续解析沿用现有段落提取，但三处修改：
  // 1) runText 与段落走查跳过 Fallback 子树（与正文契约一致，防文本框双计）；
  // 2) 原 unsupported 集合（AlternateContent/fldSimple/sym/subDoc/contentPart/oMath/oMathPara/vanish/webHidden）
  //    不再抛错：oMath/oMathPara/sym/subDoc/contentPart/vanish/webHidden/嵌套表格 记 coverage.complex++，
  //    fldSimple 与 AlternateContent(Choice) 正常提取文字；
  // 3) body 子元素白名单不再抛错：sdt/customXml/其他未知块容器递归提取段落并记 coverage.complex++。
  return { paragraphs, coverage }
}
```

`document-worker.ts` 消息改为 `{ valid: true; paragraphs; coverage }`；`readDocxInChild` 返回 `{ paragraphs, coverage }`，消息校验接受 `coverage`（缺失时按全零补）。

`parseDocument`：`complete: coverageComplete(coverage)`、`warnings` 填类别中文标签（"关键嵌图"、"修订标记"、"文本框"、"复杂结构"）。

`src/server/contract-review/tasks/repository.ts`：

```ts
export type ParseSnapshot = { id: string; paragraphs: Paragraph[]; complete: boolean; textSha256: string; coverage: ParseCoverage }
```

行读取处对旧快照补缺：

```ts
const saved = row.parse_snapshot ? parse<ParseSnapshot>(row.parse_snapshot) : null
const snapshot = saved ? { ...saved, coverage: saved.coverage ?? { images: 0, revisions: 0, textboxes: 0, complex: 0 } } : null
```

（放进现有 `load`/`checkpoint` 组装处，风格与文件内 `jsonResult` 一致。）

`src/server/contract-review/tasks/runner.ts`：

```ts
const parsed = await readDocxInChild(revision.bytes, controller.signal)
controller.signal.throwIfAborted()
job.snapshot = { id: randomUUID(), paragraphs: parsed.paragraphs, complete: coverageComplete(parsed.coverage),
  textSha256: createHash("sha256").update(parsed.paragraphs.map(item => item.text).join("\n")).digest("hex"), coverage: parsed.coverage }
```

`reviewWithAgent({ …, complete: snapshot.complete … })` 不变（现在是真实值）。

- [ ] **Step 4: 运行确认通过**

```powershell
pnpm test:contract
pnpm test
pnpm check
```

预期：PASS；若 `src/server/contract-review/tasks/*.test.ts` 因快照类型编译失败，在其夹具补 `coverage: { images: 0, revisions: 0, textboxes: 0, complex: 0 }`。

- [ ] **Step 5: 提交**

```powershell
git add tools/contract-review/src/types.ts tools/contract-review/src/document.ts tools/contract-review/src/document-worker.ts tools/contract-review/tests/document.test.ts src/server/contract-review/tasks/repository.ts src/server/contract-review/tasks/runner.ts
git commit -m "feat: record parse coverage instead of rejecting document structures"
```

---

### Task 10: Word 实开核对脚本 + 全套运行 + 引擎操作冒烟

**Files:**
- Create: `scripts/roundtrip/verify-word.ps1`
- Create: `docs/reviews/2026-10-27-docx-structure-roundtrip-validation.md`（先建骨架，Task 11 定稿）

**Interfaces:**
- Consumes: Task 5 `manifest.json`、Task 6 `engine/*.export.docx`
- Produces: `.superpowers/previews/word-structures/word-report.json`；验证记录证据

- [ ] **Step 1: 实现 verify-word.ps1**

要点（完整脚本按此写出，PowerShell 5.1 兼容）：

```powershell
param([string]$Directory = ".superpowers/previews/word-structures")
$manifest = Get-Content "$Directory/manifest.json" -Raw | ConvertFrom-Json
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$results = @()
function Get-Stories($doc) {
  $text = @{}
  foreach ($story in $doc.StoryRanges) {
    $kind = [string]$story.StoryType
    $value = $story.Text
    if ($text.ContainsKey($kind)) { $text[$kind] += $value } else { $text[$kind] = $value }
  }
  return $text
}
function Test-Expect($path, $expect) {
  $doc = $word.Documents.Open($path, $false, $true)  # ReadOnly
  try {
    $stories = Get-Stories $doc
    $body = [string]$doc.Content.Text
    $headers = @()
    foreach ($section in $doc.Sections) { foreach ($hf in $section.Headers) { if ($hf.Exists) { $headers += $hf.Range.Text } }; foreach ($hf in $section.Footers) { if ($hf.Exists) { $headers += $hf.Range.Text } } }
    $failures = @()
    foreach ($phrase in $expect.bodyContains) { if (-not $body.Contains($phrase)) { $failures += "正文缺少:$phrase" } }
    foreach ($phrase in $expect.headerContains) { if (-not (($headers -join "").Contains($phrase))) { $failures += "页眉页脚缺少:$phrase" } }
    if ($null -ne $expect.revisions -and $doc.Revisions.Count -ne $expect.revisions) { $failures += "修订数:$($doc.Revisions.Count)!=$($expect.revisions)" }
    if ($null -ne $expect.inlineShapesMin -and $doc.InlineShapes.Count -lt $expect.inlineShapesMin) { $failures += "行内图不足:$($doc.InlineShapes.Count)<$($expect.inlineShapesMin)" }
    if ($null -ne $expect.shapesMin -and $doc.Shapes.Count -lt $expect.shapesMin) { $failures += "浮动图/图形不足" }
    if ($null -ne $expect.fieldsMin -and $doc.Fields.Count -lt $expect.fieldsMin) { $failures += "域不足:$($doc.Fields.Count)<$($expect.fieldsMin)" }
    if ($null -ne $expect.tables -and $doc.Tables.Count -ne $expect.tables) { $failures += "表格数:$($doc.Tables.Count)!=$($expect.tables)" }
    if ($null -ne $expect.footnotesMin -and $doc.Footnotes.Count -lt $expect.footnotesMin) { $failures += "脚注不足" }
    return $failures
  } finally { $doc.Close($false) }
}
try {
  foreach ($item in $manifest) {
    $original = Join-Path $Directory $item.file
    $exported = Join-Path $Directory "engine/$($item.id).export.docx"
    $entry = [ordered]@{ id = $item.id; original = @(); exported = @(); resaved = $false }
    $entry.original = @(Test-Expect $original $item.expect)
    if (Test-Path $exported) {
      $entry.exported = @(Test-Expect $exported $item.expect)
      $doc = $word.Documents.Open($exported, $false, $false)
      try { $doc.SaveAs2("$Directory/engine/$($item.id).word-resaved.docx"); $entry.resaved = $true } finally { $doc.Close($false) }
    } else { $entry.exported = @("缺少导出文件") }
    $results += [pscustomobject]$entry
  }
} finally { $word.Quit() }
$report = [ordered]@{ wordVersion = $word.Version; generatedAt = (Get-Date).ToString("o"); results = $results }
$report | ConvertTo-Json -Depth 6 | Set-Content "$Directory/word-report.json" -Encoding UTF8
$failed = $results | Where-Object { $_.original.Count -or $_.exported.Count -or -not $_.resaved }
if ($failed) { Write-Output "Word 核对失败 $($failed.Count) 项"; exit 1 }
Write-Output "Word 核对全部通过（$($results.Count) 项，Word $($report.wordVersion)）"
```

注意：`$word.Version` 在 `Quit()` 之后仍可读；若 COM 对象释放顺序问题，先取版本再 Quit。受保护视图/区域标记：脚本开头对 `$Directory` 下文件执行 `Unblock-File -ErrorAction SilentlyContinue`。

- [ ] **Step 2: 全套运行**

```powershell
pnpm roundtrip
```

预期：`fixtures:structures` 生成夹具；`roundtrip:engine` 导出 13 份；`roundtrip:word` 输出 `word-report.json` 且 exit 0。若有失败项：先修样本或核对口径（如域结果刷新导致正文短语变化时，把 `bodyContains` 短语换成不依赖域结果的稳定文字）；确属引擎丢失的类别，不改断言掩盖，记录到验证记录的"降级/丢失"栏并回到设计第 3 节处置。

- [ ] **Step 3: 引擎自带操作冒烟（不列正式验收）**

在 harness 页面人工操作并记录结果（每项一句话：可执行/不可执行）：插入图片、页眉页脚编辑、新建批注、撤销重做、中文输入。记录进验证记录"引擎操作冒烟"小节，明确标注"冒烟，非 WD 验收"。

- [ ] **Step 4: 建验证记录骨架并提交**

`docs/reviews/2026-10-27-docx-structure-roundtrip-validation.md`：写入本轮执行的检查矩阵初稿（类别 × 样本 × 引擎导出 × Word 实开 × 结论），标注"本地验证（本机 Word <版本>）"。

```powershell
git add scripts/roundtrip/verify-word.ps1 docs/reviews/2026-10-27-docx-structure-roundtrip-validation.md
git commit -m "feat: verify structure round-trip with local Microsoft Word automation"
```

---

### Task 11: 验证记录定稿与收尾

**Files:**
- Modify: `docs/reviews/2026-10-27-docx-structure-roundtrip-validation.md`
- Modify: `spec/03-word-editing.md`（仅当实测要求降级声明时更新支持表）

**Interfaces:**
- Consumes: Task 10 全部产物
- Produces: WD-13/WD-14 证据结论；可发布状态

- [ ] **Step 1: 完整执行一次验证并归档证据**

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm roundtrip
```

逐项记录：命令、时间、结果；`word-report.json` 的逐样本结论摘入验证记录矩阵；`engine-report.json` 与 `word-report.json` 存档引用路径写明（`.superpowers/` 本地保留、不入库）。

- [ ] **Step 2: 验证记录定稿**

验证记录须包含：逐类别矩阵（图片、页眉页脚、域、修订标记、文本框、批注、脚注、内容控件、合并表格 × 保留/降级/丢失）、正文契约核对结果、结构对账拦截演示（人为构造一次不一致并记录报错文案）、引擎操作冒烟结果、Word 版本、"本地验证 vs CI"声明、残余缺口（域指令、页眉文字等快照不可计量项）。实测丢失的类别同步回 spec/03 支持表降级声明。

- [ ] **Step 3: 收尾提交**

```powershell
git diff --check
git add docs/reviews/2026-10-27-docx-structure-roundtrip-validation.md
git commit -m "docs: record DOCX structure round-trip validation results"
```

- [ ] **Step 4: 未决项整理（不自动创建 Issue）**

把设计文档第 8 节四项未决项整理为 Issue 草案文本交用户确认；用户授权后才创建 GitHub Issue。
