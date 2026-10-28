import { NextResponse } from "next/server"
import { StoreError } from "../../documents/repository"
import { ReviewError, safeError } from "../../../../tools/contract-review/src/errors"

export async function reviewBody(request: Request, limit = 4096): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new StoreError(415, "请求格式无效。")
  if (Number(request.headers.get("content-length")) > limit) throw new StoreError(413, "审查参数过长。")
  const reader = request.body?.getReader()
  if (!reader) throw new StoreError(400, "请求内容为空。")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) { await reader.cancel(); throw new StoreError(413, "审查参数过长。") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) }
  catch { throw new StoreError(400, "审查参数无效。") }
}
export function reviewFailure(failure: unknown) {
  const known = failure instanceof StoreError || failure instanceof ReviewError
  const status = failure instanceof StoreError ? failure.status : 503
  return NextResponse.json({ error: known ? failure.message : "审查服务暂时不可用，请稍后重试。",
    ...(failure instanceof StoreError && failure.code ? { code: failure.code } : {}),
    ...(failure instanceof StoreError && failure.session ? { session: failure.session } : {}),
    ...(failure instanceof ReviewError ? { code: safeError(failure).code } : {}) },
  { status, headers: { "Cache-Control": "private, no-store" } })
}
