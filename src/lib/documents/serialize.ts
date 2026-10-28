import { emptyCounts, type EditorStructureCounts } from "./structures"

export class WordExportTimeout extends Error {
  constructor() { super("Word 文档导出超时，当前编辑已保留，请重新加载后重试。") }
}

// Each canvas owns one serializer. A deadline rejects the caller, but cannot
// cancel the vendor export: keep the lock until that operation actually settles.
export function createWordSerializer(errorCount: () => number, timeoutMs = 60000) {
  let pending = false
  return async (operation: () => Promise<Blob>) => {
    if (pending) throw new Error("Word 文档仍在处理，请稍候或重新加载。")
    pending = true
    return serializeWord(async () => {
      try { return await operation() } finally { pending = false }
    }, errorCount, timeoutMs)
  }
}

export async function serializeWord(
  exporter: () => Promise<Blob>,
  errorCount: () => number,
  timeoutMs = 60000,
): Promise<Blob> {
  const before = errorCount()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const blob = await Promise.race([exporter(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WordExportTimeout()), timeoutMs)
    })])
    // The engine can emit an exception and return the original bytes as fallback.
    if (errorCount() !== before || !blob?.size) throw new Error("Word 文档导出失败，当前编辑已保留，请重试。")
    return blob
  } finally { clearTimeout(timer) }
}
// 节点分类以 src/lib/documents/calibration/ 的 superdoc@1.47.2 捕获样本为夹具。
// 与 docx.ts 的提取契约对称：正文取 w:t 文本，跳过 w:delText、w:instrText、w:moveFrom 子树与 mc:Fallback；
// 结构计数对应 drawing+pict、ins/del/moveFrom/moveTo/*PrChange、txbxContent、commentReference、脚注引用、gridSpan+vMerge。
type MarkLike = { type?: string; attrs?: Record<string, unknown> }
type NodeLike = { type?: string; text?: string; marks?: MarkLike[]; attrs?: Record<string, unknown>; content?: unknown[] }
type XmlNodeLike = { type?: string; name?: string; text?: string; elements?: unknown }

const markType = (mark: unknown) => String((mark as MarkLike | null)?.type ?? "")

const deletedMark = (marks: unknown): boolean =>
  Array.isArray(marks) && marks.some(mark => /delete|moveFrom/i.test(markType(mark)))

const localName = (name: unknown) => String(name ?? "").split(":").pop() ?? ""

// passthroughInline/passthroughBlock 原样承载 XML，正文与计数递归其元素树，命名匹配去前缀。
function walkXml(node: unknown, onElement: (name: string) => void, onText: (text: string) => void, inText = false, inMoveFrom = false) {
  if (Array.isArray(node)) { node.forEach(item => walkXml(item, onElement, onText, inText, inMoveFrom)); return }
  if (!node || typeof node !== "object") return
  const item = node as XmlNodeLike
  if (item.type === "text") { if (inText && !inMoveFrom) onText(item.text ?? ""); return }
  const name = localName(item.name)
  if (name === "Fallback") return
  onElement(name)
  walkXml(item.elements, onElement, onText, inText || name === "t", inMoveFrom || name === "moveFrom")
}

const passthroughXml = (node: NodeLike) => (node.attrs as { originalXml?: unknown } | undefined)?.originalXml

// 总页数域保留导入缓存文本；页码域导出实测为空结果，正文同样不占位。
const fieldText = (node: NodeLike) => {
  const attrs = (node.attrs ?? {}) as { resolvedText?: unknown; importedCachedText?: unknown }
  return typeof attrs.resolvedText === "string" ? attrs.resolvedText
    : typeof attrs.importedCachedText === "string" ? attrs.importedCachedText : ""
}

export function editorText(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  const node = value as NodeLike
  if (node.type === "text") return deletedMark(node.marks) ? "" : node.text ?? ""
  if (node.type === "total-page-number") return fieldText(node)
  if (node.type === "passthroughInline" || node.type === "passthroughBlock") {
    let out = ""
    walkXml(passthroughXml(node), () => {}, text => { out += text })
    return out
  }
  return node.content?.map(editorText).join("") ?? ""
}

export function editorStructures(value: unknown): EditorStructureCounts {
  const counts = emptyCounts()
  // 同一修订的 mark 会同时挂在 run 与 text 上，按 mark 的 id 去重；缺 id 时按出现次数计。
  const revisions = new Set<string>()
  const comments = new Set<string>()
  let looseRevisions = 0
  let looseComments = 0
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return
    const item = node as NodeLike
    for (const mark of Array.isArray(item.marks) ? item.marks : []) {
      const type = markType(mark)
      const attrs = mark?.attrs ?? {}
      if (/^track/i.test(type)) {
        const id = attrs.id
        if (typeof id === "string" && id) revisions.add(`${type}:${id}`)
        else looseRevisions++
      }
      if (/comment/i.test(type)) {
        const id = attrs.commentId
        if (typeof id === "string" && id) comments.add(id)
        else looseComments++
      }
    }
    switch (item.type) {
      // 形状导出为 w:drawing，与图片同占 images 计数（对应 docx.ts 的 drawing+pict）。
      case "image":
      case "shapeContainer":
        counts.images++
        break
      case "shapeTextbox":
        counts.textboxes++
        break
      case "footnoteReference":
      case "endnoteReference":
        counts.notes++
        break
      case "passthroughInline":
      case "passthroughBlock":
        walkXml(passthroughXml(item), name => {
          if (name === "drawing" || name === "pict") counts.images++
          else if (name === "txbxContent") counts.textboxes++
          else if (name === "ins" || name === "del" || name === "moveFrom" || name === "moveTo" || /PrChange$/.test(name)) counts.revisions++
        }, () => {})
        break
      case "tableCell": {
        const attrs = item.attrs ?? {}
        const props = (attrs.tableCellProperties ?? {}) as Record<string, unknown>
        const span = Number(attrs.colspan ?? props.gridSpan ?? 1)
        const rows = Math.max(Number(attrs.rowspan ?? 1), 1)
        const vertical = props.vMerge != null || attrs.vMerge != null || rows > 1
        if (span > 1) counts.mergedCells++
        // 模型把纵向合并区折叠为 rowspan 个 w:vMerge 元素（restart+continue），按行数计。
        if (vertical) counts.mergedCells += rows
        break
      }
      default:
        break
    }
    item.content?.forEach(walk)
  }
  walk(value)
  counts.revisions += revisions.size + looseRevisions
  counts.comments += comments.size + looseComments
  return counts
}
