import type { AuthIdentity } from "../auth/service"
import { isAuthError } from "../auth/errors"
import { isBusinessError, BusinessError, httpStatus } from "../projects/errors"
import type { ProjectEditorService } from "./editor"
import type { ProjectDocumentVersion } from "./document-repository"

export type ProjectEditorHttpDependencies = { requireAccount(request: Request): Promise<AuthIdentity>; origin(): string; editor: ProjectEditorService }
type Params = { id: string; documentId?: string; versionId?: string }
type Context = { params: Promise<Params> }
const headers = { "Cache-Control": "private, no-store" }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
const invalid = () => new BusinessError("INVALID_INPUT", "文档请求无效。")
const view = (value: Awaited<ReturnType<ProjectEditorService["open"]>>) => {
  const v: ProjectDocumentVersion = value.version
  return { document: value.document, canEdit: value.canEdit, version: { id: v.id, projectId: v.projectId, documentId: v.documentId, parentId: v.parentId, sha256: v.sha256, size: v.size, createdAt: v.createdAt, editorVersion: v.editorVersion } }
}
async function body(request: Request, max = 29 * 1024 * 1024): Promise<Record<string, unknown>> {
  const size = Number(request.headers.get("content-length"))
  if (!Number.isFinite(size) || size < 0 || size > max) throw invalid()
  const reader = request.body?.getReader()
  if (!reader) throw invalid()
  let length = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const value = await reader.read()
    if (value.done) break
    length += value.value.length
    if (length > max) { await reader.cancel(); throw invalid() }
    chunks.push(value.value)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid()
    return parsed as Record<string, unknown>
  } catch { throw invalid() }
}
function saveInput(input: Record<string, unknown>) {
  if (typeof input.blob !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.blob)) throw invalid()
  const bytes = Buffer.from(input.blob, "base64")
  if (bytes.toString("base64") !== input.blob || !bytes.length || bytes.length > 20 * 1024 * 1024) throw invalid()
  if (typeof input.baseVersionId !== "string" || typeof input.operationId !== "string" || typeof input.title !== "string" || (input.prompt !== undefined && typeof input.prompt !== "string") || (input.editorVersion !== undefined && typeof input.editorVersion !== "string")) throw invalid()
  return { bytes, input: { baseVersionId: input.baseVersionId, operationId: input.operationId, title: input.title, prompt: input.prompt as string | undefined, editorVersion: (input.editorVersion as string | undefined) ?? "superdoc@1.47.2" } }
}
export function createProjectEditorHandlers(load: () => Promise<ProjectEditorHttpDependencies>) {
  function route(action: (d: ProjectEditorHttpDependencies, i: AuthIdentity, p: Params, r: Request) => Promise<Response>, write = false) {
    return async (request: Request, context: Context) => {
      try {
        const d = await load(), identity = await d.requireAccount(request)
        if (write && request.headers.get("origin") !== d.origin()) throw new BusinessError("FORBIDDEN", "请求来源无效。")
        return await action(d, identity, await context.params, request)
      } catch (failure) {
        if (isBusinessError(failure)) return json({ error: { code: failure.code, message: failure.message } }, httpStatus[failure.code])
        if (isAuthError(failure) && failure.code === "UNAUTHENTICATED") return json({ error: { code: "UNAUTHENTICATED", message: "请先登录。" } }, 401)
        return json({ error: { code: "SERVICE_UNAVAILABLE", message: "文档服务暂不可用，请稍后重试。" } }, 503)
      }
    }
  }
  const content = route(async (d, i, p, r) => {
    const value = await d.editor.content(i, p.id, p.documentId ?? "", p.versionId ?? new URL(r.url).searchParams.get("versionId") ?? "")
    return new Response(Buffer.from(value.bytes), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff" } })
  })
  return {
    list: route(async (d, i, p) => json({ documents: await d.editor.list(i, p.id) })),
    create: route(async (d, i, p, r) => { const b = await body(r, 2048); if (typeof b.materialId !== "string" || typeof b.materialVersionId !== "string") throw invalid(); return json(view(await d.editor.create(i, p.id, b.materialId, b.materialVersionId)), 201) }, true),
    open: route(async (d, i, p) => json(view(await d.editor.open(i, p.id, p.documentId ?? "")))),
    preflight: route(async (d, i, p) => { await d.editor.preflight(i, p.id, p.documentId ?? ""); return json({ canEdit: true }) }, true),
    save: route(async (d, i, p, r) => { const b = saveInput(await body(r)); return json(view(await d.editor.save(i, p.id, p.documentId ?? "", b.input, b.bytes))) }, true),
    copy: route(async (d, i, p, r) => { const b = saveInput(await body(r)); return json(view(await d.editor.copy(i, p.id, p.documentId ?? "", b.input, b.bytes)), 201) }, true),
    content,
    download: content,
  }
}
