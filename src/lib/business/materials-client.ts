import { EditorAccessError } from "../documents/editor-access"

export type MaterialSummary = {
  id: string; title: string; format: "docx" | "pdf"; versionId: string
  parseTaskId: string | null; parseState: string | null; snapshotId: string | null
  coverage: null | { status: "available" | "partial" | "failed"; textLength: number; pageCount: number | null; findings: { code: string; location: string }[] }
}
export type MaterialUpload = {
  title: string; sourceKind: "synthetic" | "authorized"; sourceReference: string
  purpose: string; retentionUntil: string; processingAuthorized: boolean
}

export function createProjectMaterialsClient(options: {
  projectId: string; isCurrent: () => boolean; onAccessInvalid: (failure: unknown) => void; fetch?: typeof fetch
}) {
  const transport = options.fetch ?? fetch
  const base = `/api/projects/${encodeURIComponent(options.projectId)}/materials`
  function check(signal?: AbortSignal) {
    if (!options.isCurrent() || signal?.aborted) throw new EditorAccessError("ABORTED", "操作已取消。")
  }
  async function request(path: string, signal?: AbortSignal, body?: FormData) {
    check(signal)
    let response: Response
    try { response = await transport(base + path, { signal, cache: "no-store", credentials: "same-origin", ...(body ? { method: "POST", body } : {}) }) }
    catch { check(signal); throw new EditorAccessError("FAILED", "网络连接失败，请重试。") }
    check(signal)
    if (!response.ok) {
      const code = response.status === 401 ? "SESSION_INVALID" : response.status === 403 ? "ACCESS_DENIED" : response.status === 503 ? "UNAVAILABLE" : "FAILED"
      let message = "材料操作失败，请重试。"
      try {
        const value = await response.json() as { error?: { message?: unknown } }
        check(signal)
        if (typeof value.error?.message === "string") message = value.error.message
      } catch (failure) { if (failure instanceof EditorAccessError) throw failure }
      const failure = new EditorAccessError(code, message)
      if (code === "SESSION_INVALID" || code === "ACCESS_DENIED") options.onAccessInvalid(failure)
      throw failure
    }
    return response
  }
  async function json<T>(path: string, signal?: AbortSignal, body?: FormData) {
    const response = await request(path, signal, body)
    const value = await response.json() as T
    check(signal)
    return value
  }
  return {
    list: (signal?: AbortSignal) => json<{ materials: MaterialSummary[] }>("", signal),
    async upload(file: File, input: MaterialUpload, signal?: AbortSignal) {
      const body = new FormData()
      body.set("file", file)
      body.set("metadata", JSON.stringify({ ...input, fileName: file.name }))
      return json<{ parseTaskId: string }>("", signal, body)
    },
    async content(material: MaterialSummary, signal?: AbortSignal) {
      const response = await request(`/${encodeURIComponent(material.id)}/versions/${encodeURIComponent(material.versionId)}/content`, signal)
      const blob = await response.blob()
      check(signal)
      return blob
    },
  }
}
