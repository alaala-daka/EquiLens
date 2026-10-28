import type { AuthIdentity } from "../auth/service"
import { isAuthError } from "../auth/errors"
import { BusinessError, httpStatus } from "../projects/errors"
import type { MaterialService } from "./service"
import type { QueuedMaterialService } from "./queued"

export type MaterialHttpDependencies = {
  requireAccount: (request: Request) => Promise<AuthIdentity>
  origin: () => string
  reads: MaterialService
  writes: QueuedMaterialService
}
type Params = { id: string; materialId?: string; versionId?: string; snapshotId?: string; fragmentId?: string }
export type MaterialContext = { params: Promise<Params> }
const headers = { "Cache-Control": "private, no-store" }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
const bad = () => new BusinessError("INVALID_INPUT", "请求内容无效。")
const maxBody = 21 * 1024 * 1024

export function createMaterialHandlers(load: () => Promise<MaterialHttpDependencies>) {
  function route(action: (deps: MaterialHttpDependencies, identity: AuthIdentity, p: Params, request: Request) => Promise<Response>, write = false) {
    return async (request: Request, context: MaterialContext) => {
      try {
        const deps = await load()
        const identity = await deps.requireAccount(request)
        if (write && request.headers.get("origin") !== deps.origin()) throw new BusinessError("FORBIDDEN", "请求来源无效。")
        return await action(deps, identity, await context.params, request)
      } catch (error) {
        if (error instanceof BusinessError) return json({ error: { code: error.code, message: error.message } }, httpStatus[error.code])
        if (isAuthError(error) && error.code === "UNAUTHENTICATED") return json({ error: { code: "UNAUTHENTICATED", message: "请先登录。" } }, 401)
        return json({ error: { code: "SERVICE_UNAVAILABLE", message: "服务暂不可用，请稍后重试。" } }, 503)
      }
    }
  }
  return {
    list: route(async (d, i, p) => json({ materials: await d.reads.listMaterials(i, p.id) })),
    upload: route(async (d, i, p, request) => {
      const declared = Number(request.headers.get("content-length"))
      if (!Number.isFinite(declared) || declared < 0 || declared > maxBody) throw bad()
      // Bounded read precedes formData even for chunked or falsely declared multipart bodies.
      const reader = request.body?.getReader()
      if (!reader) throw bad()
      const chunks: Uint8Array[] = []; let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > maxBody) { await reader.cancel(); throw new BusinessError("LIMIT_EXCEEDED", "材料超过 20 MiB 限制，请缩减后重试。") }
        chunks.push(value)
      }
      const bytes = Buffer.concat(chunks)
      const copy = new Request(request.url, { method: "POST", headers: request.headers, body: bytes })
      let form: FormData
      try { form = await copy.formData() } catch { throw bad() }
      const file = form.get("file"), metadata = form.get("metadata")
      if (!(file instanceof File) || typeof metadata !== "string" || metadata.length > 16384) throw bad()
      let body: unknown
      try { body = JSON.parse(metadata) } catch { throw bad() }
      return json(await d.writes.upload(i, p.id, body, new Uint8Array(await file.arrayBuffer())), 202)
    }, true),
    detail: route(async (d, i, p) => {
      const materials = await d.reads.listMaterials(i, p.id)
      const material = materials.find(m => m.id === p.materialId)
      if (!material) throw new BusinessError("NOT_FOUND", "找不到该材料。")
      return json({ material })
    }),
    content: route(async (d, i, p) => {
      const value = await d.reads.readMaterialVersion(i, { projectId: p.id, materialId: p.materialId, versionId: p.versionId })
      return new Response(Buffer.from(value.bytes), { headers: { ...headers, "Content-Type": value.contentType, "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff" } })
    }),
    snapshot: route(async (d, i, p) => {
      const value = await d.reads.readParseSnapshot(i, { projectId: p.id, snapshotId: p.snapshotId })
      if (value.material.id !== p.materialId) throw new BusinessError("NOT_FOUND", "找不到该材料。")
      return json(value)
    }),
    source: route(async (d, i, p) => {
      const value = await d.reads.readSource(i, { projectId: p.id, snapshotId: p.snapshotId, fragmentId: p.fragmentId })
      if (value.snapshot.materialId !== p.materialId) throw new BusinessError("NOT_FOUND", "找不到该材料。")
      return json(value)
    }),
    reparse: route(async (d, i, p, request) => {
      if (Number(request.headers.get("content-length")) > 2048) throw bad()
      const reader = request.body?.getReader()
      if (!reader) throw bad()
      const chunks: Uint8Array[] = []; let length = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > 2048) { await reader.cancel(); throw bad() }
        chunks.push(value)
      }
      const text = Buffer.concat(chunks).toString("utf8")
      let input: { operationId?: unknown }
      try { input = JSON.parse(text) } catch { throw bad() }
      if (typeof input?.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/.test(input.operationId)) throw bad()
      return json(await d.writes.reparse(i, p.id, p.materialId ?? "", input.operationId), 202)
    }, true),
  }
}
