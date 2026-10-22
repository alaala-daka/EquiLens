import { createHash, randomBytes } from "node:crypto"
import { NextResponse, type NextRequest } from "next/server"
import { MAX_FILE_BYTES } from "../../lib/documents/docx"
import { DOCX_TYPE, type OpenDocument, type DocumentRecord } from "../../lib/documents/types"
import { StoreError } from "./repository"
import { validateUpload } from "./validate"

const cookieName = "equilens_session"
export function session(request: NextRequest) {
  const existing = request.cookies.get(cookieName)?.value
  const token = existing && /^[a-f0-9]{64}$/.test(existing) ? existing : randomBytes(32).toString("hex")
  return { owner: createHash("sha256").update(token).digest("hex"), apply(response: NextResponse) {
    if (token !== existing) response.cookies.set(cookieName, token, { httpOnly: true, sameSite: "lax", secure: new URL(process.env.APP_ORIGIN ?? request.url).protocol === "https:", path: "/", maxAge: 365 * 86400 })
    response.headers.set("Cache-Control", "private, no-store")
    return response
  } }
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin")
  const url = new URL(request.url)
  const expected = process.env.APP_ORIGIN ?? `${url.protocol}//${request.headers.get("host") ?? url.host}`
  if (!origin || origin !== new URL(expected).origin) throw new StoreError(403, "请求来源无效。")
}

export async function inputBody(request: Request): Promise<Record<string, unknown> & { title: string; prompt: string; blob: Blob }> {
  const limit = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 128 * 1024
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new StoreError(415, "请求格式无效。")
  if (Number(request.headers.get("content-length")) > limit) throw new StoreError(413, "文档超过大小限制。")
  const reader = request.body?.getReader()
  if (!reader) throw new StoreError(400, "请求内容为空。")
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new StoreError(413, "文档超过大小限制。") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  let body: Record<string, unknown>
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) }
  catch { throw new StoreError(400, "请求内容无效。") }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new StoreError(400, "请求内容无效。")
  if (typeof body.title !== "string" || body.title.length > 200 || typeof body.prompt !== "string" || body.prompt.length > 20000 || typeof body.blob !== "string" || body.blob.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) || /[^A-Za-z0-9+/=]/.test(body.blob)) throw new StoreError(400, "文档内容或字段无效。")
  const bytes = Buffer.from(body.blob, "base64")
  if (bytes.toString("base64") !== body.blob || bytes.length > MAX_FILE_BYTES) throw new StoreError(400, "文档内容无效。")
  await validateUpload(bytes)
  return { ...body, title: body.title, prompt: body.prompt, blob: new Blob([bytes], { type: DOCX_TYPE }) }
}

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new StoreError(400, "文档标识无效。")
  return value
}

export function creation(body: Awaited<ReturnType<typeof inputBody>>) {
  const source = body.source as DocumentRecord["source"]
  if (!["authored", "imported", "copy"].includes(source)) throw new StoreError(400, "文档来源无效。")
  if (body.fileName !== undefined && (typeof body.fileName !== "string" || body.fileName.length > 255)) throw new StoreError(400, "文件名无效。")
  let copiedFrom: DocumentRecord["copiedFrom"]
  if (source === "copy") {
    const reference = body.copiedFrom as Record<string, unknown> | undefined
    copiedFrom = { documentId: identifier(reference?.documentId), revisionId: identifier(reference?.revisionId) }
  } else if (body.copiedFrom !== undefined) throw new StoreError(400, "复制来源无效。")
  return { blob: body.blob, title: body.title, prompt: body.prompt, source, fileName: body.fileName as string | undefined, copiedFrom }
}

export async function wire(value: OpenDocument) {
  return { document: value.document, revision: { ...value.revision, blob: Buffer.from(await value.revision.blob.arrayBuffer()).toString("base64") } }
}

export function failureResponse(failure: unknown) {
  if (failure instanceof StoreError) return NextResponse.json({ error: failure.message }, { status: failure.status, headers: { "Cache-Control": "private, no-store" } })
  console.error("Document storage request failed")
  return NextResponse.json({ error: "文档存储暂时不可用，请保留当前编辑并重试。" }, { status: 503, headers: { "Cache-Control": "private, no-store" } })
}
