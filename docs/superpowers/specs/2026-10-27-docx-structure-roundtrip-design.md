# DOCX 结构放行与往返验证设计

日期：2026-10-27。状态：设计已经用户逐节确认，待用户审阅本文档后进入实施计划。
本文档是设计过程产物，不是契约权威；已接受的行为契约由 `spec/03-word-editing.md`、`spec/01-product.md` 拥有，实施前先按第 5 节更新规格。

## 0. 背景与目标

EquiLens 目前在 `src/lib/documents/docx.ts` 的 `validateDocxBytes` 拒绝一切包含
图片、页眉页脚、域、修订标记、文本框、批注、脚注、内容控件、合并单元格的 DOCX，
报错为笼统的“文档包含暂不支持的图片、页眉页脚、域、修订或复杂结构”。
真实合同几乎都含页眉页脚、页码、公司图片与修订标记，导致编辑器无法处理实际业务文档。

目标：内容结构全部放行并往返保留，仅保留安全类拒绝；以合成样本、浏览器引擎往返
与本机 Microsoft Word 实开核对为证据，逐类别声明支持，不冒充通过。

## 0.1 已确认的需求决策

| 决策点 | 结论 |
| --- | --- |
| 支持层次 | 全量支持：含修订标记、文本框、复杂域的文档可打开、编辑、保存、导出 |
| 修订能力 | 仅往返保留（作者/时间/标记完整保留）；不做接受/拒绝，不提供修订模式开关 |
| 放行边界 | 内容结构全部放行；宏/ActiveX、OLE/嵌入对象、外部资源、altChunk、嵌套压缩 继续拒绝 |
| 验证方式 | 全自动：往返样本 + 浏览器引擎往返 + 本机 Word COM 实开核对，形成验证记录 |
| 操作面 | 往返保留为交付重点；引擎自带操作不封锁、只做冒烟并如实记录，不列为正式验收 |

## 1. 架构与校验契约

组件边界不变：`docx.ts`（共享校验/检查）、`docx.worker.ts`（浏览器入口）、
`parse-worker.ts`（服务端入口）、`serialize.ts`/`word-canvas.tsx`（导出核对）、
`tools/contract-review/src/document.ts`（解析段落）。改动集中在共享校验器与提取语义。

校验器改为两层：

- **安全层（原样保留）**：ZIP 目录/膨胀/路径/加密、宏/ActiveX/OLE/嵌入对象/嵌套压缩、
  外部资源与外链模板、DOCTYPE/ENTITY、宏内容类型。`altChunk`、`object` 属嵌入内容，
  继续拒绝，报错保留并归入安全类。
- **结构层（白名单 → 清单）**：删除现有结构拒绝（`docx.ts:175`）。在 `word/*.xml`
  全部部件上统计结构清单并随校验结果返回：

```ts
type DocumentStructures = {
  images: number; headerFooterRefs: number
  fields: { simple: number; complex: number }  // simple=w:fldSimple，complex=w:fldChar+instrText 序列
  revisions: { insertions: number; deletions: number; moves: number; formatChanges: number }
  textboxes: number; comments: number; notes: number
  contentControls: number; mergedCells: number   // gridSpan + vMerge
}
validateDocxBytes(bytes, expectedText?): { text: string; structures: DocumentStructures }
```

“正文”提取契约（导出核对两端同一口径）：

| 计入正文 | 不计入 |
| --- | --- |
| `document.xml` 的 `w:t`：表格、文本框正文、修订插入文字、域结果文字 | `w:delText`（含 moveFrom 离开文字）、域指令 `w:instrText`、`mc:Fallback` 分支（文本框 Choice/Fallback 双份存储，跳过防双计）、页眉页脚/批注/脚注部件文字（本就在独立部件） |

`editorText()` 同步扩展：跳过引擎 JSON 中删除内容/脚注/批注等节点，与上表对齐。
具体节点类型以 superdoc@1.47.2 实测 JSON 输出校准，校准样本固化为测试夹具。

## 2. 数据流

**导入**：WordCanvas → `validateDocx(blob, signal, prepare=true)` → worker 安全校验 +
结构清单 + `prepareDocxBytes` 补工作副本（原件/保存字节不动）→ 引擎打开。
清单不进界面，只服务导出核对与解析覆盖。

**保存/导出**（锁步不变，换核对口径）：

1. 快照 JSON + `editorText` 正文 → 锁定引擎输入 → 导出 DOCX → 导出前后编辑内容一致检查 →
   `validateDocx(blob, signal, false, text)`：安全校验 + 正文比对 + 结构对账（第 3 节）→
   通过才提交存储事务。
2. 无更改导出直接下载保存字节；失败保留编辑/保存版本、可重试，语义全部不变。
3. 结构清单是派生数据，不写入 DOCX 字节，不进原件/版本记录，不参与摘要。

**服务端**：

1. create/save 上传 → `parse-worker` 子进程：安全层不变，结构不再拒绝，返回 `{valid, structures}`。
2. 合同审查任务：`readDocxInChild` 段落提取照旧；`ParseSnapshot` 增加 `coverage`
   （清单派生），兑现 spec/01 §98：出现关键嵌图、修订标记、文本框、无法可靠读取的复杂结构时
   `complete=false` 并列出具体类别。页眉页脚、页码、简单域不降级完整性。
3. `reviewWithAgent(complete: …)` 从硬编码 `true` 变为真实覆盖结论。

**不变项**：原件不可变、版本链、摘要、幂等保存、迟回调/多标签冲突、会话隔离、留存删除。

## 3. 错误处理

- 安全层拒绝原样保留并各自精确报错；删除“暂不支持的图片、页眉页脚…”笼统信息。
- 内容结构不再产生拒绝。
- **导出结构对账**：正文文字精确相等之外，导出 DOCX 清单的 图片/修订标记/批注/脚注引用/
  文本框/合并单元格 数量不得少于快照 JSON 对应数量（相等为常态，具体归一化口径在引擎校准
  阶段定死并写入夹具）。用户删除内容时快照同步减少，两侧一致，正常通过；
  引擎导出丢结构则导出侧偏少，拒绝提交、保留编辑、走现有快照恢复路径。
- 报错文案：文字不一致沿用“导出正文与编辑内容不一致，此次结果未保存，请重试。”；
  结构丢失用“导出结果与编辑内容不一致（修订标记/图片…未保留），此次结果未保存，请重试。”
- 快照 JSON 无法计量的类别（域指令、页眉文字等）列为残余缺口，由 Word 实开核对兜底并
  如实记入验证记录，不写成已有保障。
- 验证期若发现某类结构实测丢失：优先修复；修不动则在 spec 支持表降级标注并附证据，
  运行时结构对账拦下静默丢内容的导出，不放行。

## 4. 验证方案

1. **单元测试**（`pnpm test`）：结构放行与清单计数；文字契约矩阵（ins 计入 / delText·moveFrom
   不计入 / moveTo 计入 / instrText 不计入、域结果计入 / Choice-Fallback 去重 / 页眉脚注批注
   不入正文）；结构对账逻辑（含正常删除不误报）；`editorText` 节点校准夹具；安全拒绝回归。
2. **往返样本套件**（合成数据）：行内/浮动图片、页眉页脚（文字+页码域+图）、简单域
   （PAGE/NUMPAGES）、复杂域（TOC）、文本框（DrawingML 与 VML）、批注、脚注/尾注、
   内容控件、合并单元格、复杂合并表、修订（ins/del/rPrChange/moveFrom/moveTo）、
   房建机电安装分包合同结构的综合样本。
3. **引擎往返 harness**（本地 dev + 浏览器自动化驱动 Edge）：逐样本 打开 → 最小编辑 →
   保存/导出 → 回收导出字节，脚本可重复执行。
4. **Word 实开核对**（PowerShell + Word COM，本机 Office16）：原件与导出件 打开无修复提示、
   提取正文/页眉页脚/脚注文字、统计 图片/修订/域/表格 数量与预期清单比对、Word 另存验证
   OOXML 自洽；记录 Word 版本。
5. **验证记录**：`docs/reviews/` 逐类别矩阵（保留/降级/丢失）+ 证据，本地验证与 CI 检查分开标注；
   spec/03 §7 新增 WD-13（逐类别往返 + Word 实开）、WD-14（导出结构对账拦截），
   原 WD-01—12 编号不动，不计入法律业务准确率分母；引擎自带操作冒烟如实记录，不列正式验收。

## 5. 契约与文档改动清单

| 文档 | 改动 |
| --- | --- |
| `spec/03-word-editing.md` | §1 明确含修订标记文档可往返保留、修订编辑仍不在范围；§3 改写图片插入等操作边界为“往返保留为交付重点、引擎操作不封锁冒烟记录”；§6 用结构支持表替换拒绝/样本两行，写入安全拒绝清单与导出核对口径；§7 新增 WD-13、WD-14 |
| `spec/01-product.md` | §98 检测义务补指向 ParseSnapshot 覆盖记录的兑现位置 |
| `README.md` | 第 48 行拒绝清单同步（结构类移除、安全类保留） |
| `tools/contract-review/README.md` | 第 223 行支持范围表述同步 |
| `docs/reviews/` | 实现后验证记录 |
| `AGENTS.md` | 不动：修订标记保留 ≠ 修订编辑，未触碰 tracked-change editing 边界 |

顺序：spec 更新 → 实现 → 测试 → 本地往返 + Word 实开验证 → 验证记录。

## 6. 诚实边界与已知风险

- SuperDoc 官方文档（v2）声明修订/批注/复杂表全保，但明确段落属性修订、表格行列修订、
  移动修订（moveFrom/moveTo）“目前按已接受内容导入”。本项目固定 superdoc@1.47.2，
  实际保留能力以本次往返样本 + Word 实开结果为准；实测丢失的类别如实降级声明。
- Word COM 核对是本机本地验证（本机 Office16），CI 无 Word；验证记录分开标注，不冒充 CI 跑过。
- 结构对账只覆盖快照 JSON 可计量类别；域指令、页眉文字等残余缺口依赖 Word 实开核对与人工抽查。
- 编辑器可显示与业务解析/审查覆盖分开：不因能显示就宣称已分析（spec/01 §98 由 coverage 兑现）。

## 7. 与三人开发计划的关系

`docs/superpowers/plans/2026-10-27-three-person-development-plan.md` 将
`word-canvas.tsx`、`document-editor.tsx`、`editor-session.ts` 登记在甲名下，
Word 规格（spec/03）为三方共用契约。本设计修改共享校验器 `docx.ts`、导出核对与
spec/03，属于跨角色契约变更：实施前由三方知会，文件归属与联调按总计划的交接约定执行。
本设计不改变项目/权限模型，不触碰乙的业务主线与丙的平台接口。

## 8. 未决项（拟入 GitHub Issues，创建前需用户授权）

1. moveFrom/moveTo 修订在 1.47.2 实测丢失时的处置：降级声明 vs 该类修订导入时显式处理。
2. 域结果刷新口径：Word 打开后自动刷新域导致结果文字变化时，往返核对的比对容差。
3. 页眉页脚/页码文字是否未来纳入业务分析正文覆盖（当前不纳入，仅记录存在）。
4. Word COM 自动化的本机配置项（宏安全/受保护视图/信任位置）与执行脚本的登记位置。
