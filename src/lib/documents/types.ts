export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
export const EDITOR_VERSION = "superdoc@1.47.2"

export type DocumentRecord = {
  id: string
  title: string
  prompt: string
  source: "authored" | "imported" | "copy"
  copiedFrom?: { documentId: string; revisionId: string }
  createdAt: string
  updatedAt: string
  currentRevision: string
}

export type Revision = {
  id: string
  documentId: string
  parentId: string | null
  blob: Blob
  hash: string
  createdAt: string
  editorVersion: string
  templateVersion: string | null
}

export type OpenDocument = { document: DocumentRecord; revision: Revision }

export function documentTitle(title: string) {
  return title.trim().slice(0, 200) || "未命名文档"
}

export function downloadName(title: string) {
  return documentTitle(title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/(?:\.docx)+$/i, "").replace(/[. ]+$/, "") + ".docx"
}

export function errorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "QuotaExceededError") return "存储空间不足，请保留当前编辑并释放空间后重试。"
  return error instanceof Error ? error.message : "操作失败，请重试。"
}
