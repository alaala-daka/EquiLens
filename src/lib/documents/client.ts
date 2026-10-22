import { DOCX_TYPE, documentTitle, type DocumentRecord, type OpenDocument } from "./types"

export class RevisionConflict extends Error {
  constructor() { super("文档已在其他页面保存。请将当前编辑另存为新文档。") }
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`/api/documents${path}`, { ...init, credentials: "same-origin", cache: "no-store" })
  const value = await response.json()
  if (response.status === 409) throw new RevisionConflict()
  if (!response.ok) throw new Error(value.error || "文档操作失败，请重试。")
  return value
}

type WireDocument = Omit<OpenDocument, "revision"> & { revision: Omit<OpenDocument["revision"], "blob"> & { blob: string } }
function decode(value: WireDocument): OpenDocument {
  const bytes = Uint8Array.from(atob(value.revision.blob), character => character.charCodeAt(0))
  return { ...value, revision: { ...value.revision, blob: new Blob([bytes], { type: DOCX_TYPE }) } }
}
async function encode(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let index = 0; index < bytes.length; index += 16384) binary += String.fromCharCode(...bytes.subarray(index, index + 16384))
  return btoa(binary)
}

export function listDocuments(): Promise<DocumentRecord[]> { return request("") }
export async function openDocument(id: string) { return decode(await request(`/${encodeURIComponent(id)}`)) }
export async function createDocument(blob: Blob, title: string, source: DocumentRecord["source"], fileName?: string, prompt = "", copiedFrom?: DocumentRecord["copiedFrom"]) {
  return decode(await request("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blob: await encode(blob), title: documentTitle(title), source, fileName, prompt, copiedFrom }) }))
}
export async function saveDocument(input: { documentId: string; baseRevision: string; operationId: string; title: string; prompt: string; blob: Blob }) {
  return decode(await request(`/${encodeURIComponent(input.documentId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, title: documentTitle(input.title), blob: await encode(input.blob) }) }))
}
