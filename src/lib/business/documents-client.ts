import { EditorAccessError, downloadDocument, type EditorAccess } from "../documents/editor-access"
import { DOCX_TYPE, EDITOR_VERSION, type OpenDocument } from "../documents/types"

export type ProjectDocument = {
  id: string; projectId: string; title: string; prompt?: string; currentVersionId: string
  createdAt: string; updatedAt: string; materialId: string; materialVersionId: string
  copiedFrom: null | { documentId: string; versionId: string }
}

export type ProjectDocumentView = {
  document: ProjectDocument
  version: { id: string; documentId: string; parentId: string | null; sha256: string; createdAt: string; editorVersion: string }
  canEdit: boolean
}

const errorMessages: Record<number, string> = {
  401: "登录状态已失效，请重新登录。",
  403: "无权访问此文档。",
  409: "文档版本已更新，请刷新后重试。",
  503: "文档存储暂不可用，请稍后重试。",
}

export function createProjectDocumentsClient(options: {
  projectId: string
  isCurrent: () => boolean
  canEdit?: () => boolean
  fetch?: typeof fetch
  onAccessInvalid?: (failure: unknown) => void
  download?: EditorAccess["download"]
}) {
  const transport = options.fetch ?? fetch
  const base = `/api/projects/${encodeURIComponent(options.projectId)}/documents`
  let pendingCopy: { key: string; operationId: string } | null = null
  function check(signal?: AbortSignal) {
    if (!options.isCurrent() || signal?.aborted) throw new EditorAccessError("ABORTED", "操作已取消。")
  }
  async function request(path: string, signal?: AbortSignal, body?: unknown) {
    check(signal)
    let response: Response
    try {
      response = await transport(base + path, { signal, cache: "no-store", credentials: "same-origin", ...(body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }) })
    } catch (failure) {
      check(signal)
      if (failure instanceof Error && failure.name === "AbortError") throw new EditorAccessError("ABORTED", "操作已取消。")
      throw new EditorAccessError("FAILED", "网络连接失败，请重试。")
    }
    check(signal)
    if (!response.ok) {
      const code = response.status === 401 ? "SESSION_INVALID" : response.status === 403 ? "ACCESS_DENIED"
        : response.status === 409 ? "CONFLICT" : response.status === 503 ? "UNAVAILABLE" : "FAILED"
      let message = errorMessages[response.status] ?? "文档操作失败，请重试。"
      try {
        const value = await response.json() as { error?: unknown }
        const serverMessage = typeof value.error === "string" ? value.error
          : typeof value.error === "object" && value.error !== null ? (value.error as { message?: unknown }).message : undefined
        if (typeof serverMessage === "string" && serverMessage.trim()) message = serverMessage
      } catch {
        // Non-JSON failure bodies keep the status-specific message.
      }
      check(signal)
      const failure = new EditorAccessError(code, message)
      if (code === "SESSION_INVALID" || code === "ACCESS_DENIED") options.onAccessInvalid?.(failure)
      throw failure
    }
    return response
  }
  async function json<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
    const response = await request(path, signal, body)
    const value = await response.json() as T
    check(signal)
    return value
  }
  const route = (id: string) => `/${encodeURIComponent(id)}`
  async function opened(view: ProjectDocumentView, signal?: AbortSignal): Promise<OpenDocument> {
    if (view.document.projectId !== options.projectId) throw new EditorAccessError("ACCESS_DENIED", "无法访问文档。")
    const response = await request(`${route(view.document.id)}/versions/${encodeURIComponent(view.version.id)}/content`, signal)
    const blob = await response.blob()
    check(signal)
    return {
      document: { ...view.document, prompt: view.document.prompt ?? "", currentRevision: view.document.currentVersionId,
        source: view.document.copiedFrom ? "copy" : "imported",
        copiedFrom: view.document.copiedFrom ? { documentId: view.document.copiedFrom.documentId, revisionId: view.document.copiedFrom.versionId } : undefined },
      revision: { ...view.version, blob: new Blob([blob], { type: DOCX_TYPE }), hash: view.version.sha256, templateVersion: null },
    }
  }
  async function encode(blob: Blob, signal?: AbortSignal) {
    check(signal)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    check(signal)
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  const access: EditorAccess = {
    async open(id, config) {
      const view = await json<ProjectDocumentView>(route(id), config?.signal)
      if (!view.canEdit) throw new EditorAccessError("ACCESS_DENIED", "此文档为只读。")
      return opened(view, config?.signal)
    },
    async preflight(id, config) { checkEdit(); await json(`${route(id)}/preflight`, config.signal, {}) },
    async save(input, config) {
      checkEdit()
      const blob = await encode(input.blob, config?.signal)
      return opened(await json<ProjectDocumentView>(`${route(input.documentId)}/save`, config?.signal, {
        baseVersionId: input.baseRevision, operationId: input.operationId, title: input.title,
        prompt: input.prompt, editorVersion: EDITOR_VERSION, blob,
      }), config?.signal)
    },
    async copy(input, config) {
      checkEdit()
      if (!input.copiedFrom) throw new EditorAccessError("FAILED", "缺少来源版本。")
      const blob = await encode(input.blob, config?.signal)
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(blob))
      check(config?.signal)
      const key = JSON.stringify([input.copiedFrom, input.title, input.prompt ?? "", Array.from(new Uint8Array(digest))])
      if (pendingCopy?.key !== key) pendingCopy = { key, operationId: crypto.randomUUID() }
      const result = await opened(await json<ProjectDocumentView>(`${route(input.copiedFrom.documentId)}/copy`, config?.signal, {
        baseVersionId: input.copiedFrom.revisionId, operationId: pendingCopy.operationId, title: input.title,
        prompt: input.prompt ?? "", editorVersion: EDITOR_VERSION, blob,
      }), config?.signal)
      pendingCopy = null
      return result
    },
    download(blob, title) { check(); (options.download ?? downloadDocument)(blob, title) },
    notifySessionInvalid: options.onAccessInvalid,
  }
  function checkEdit() {
    if (options.canEdit?.() === false) throw new EditorAccessError("ACCESS_DENIED", "此项目为只读。")
  }
  return {
    access,
    list: (signal?: AbortSignal) => json<{ documents: ProjectDocument[] }>("", signal),
    view: (id: string, signal?: AbortSignal) => json<ProjectDocumentView>(route(id), signal),
    importMaterial: (materialId: string, materialVersionId: string, signal?: AbortSignal) => json<ProjectDocumentView>("", signal, { materialId, materialVersionId }),
    async download(id: string, versionId: string, signal?: AbortSignal) {
      const response = await request(`${route(id)}/download?versionId=${encodeURIComponent(versionId)}`, signal)
      const blob = await response.blob()
      check(signal)
      return blob
    },
  }
}
