import type { DocumentRecord } from "./types"

export const documentSourceLabel: Record<DocumentRecord["source"], string> = {
  authored: "新建", imported: "导入", copy: "副本",
}

export function selectDocuments(documents: readonly DocumentRecord[], query: string): DocumentRecord[] {
  const needle = query.trim().toLowerCase()
  return documents.filter(document => document.title.toLowerCase().includes(needle))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const updatedAtFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
})

export function formatDocumentUpdatedAt(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "时间不可用"
  const parts = Object.fromEntries(updatedAtFormatter.formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}
