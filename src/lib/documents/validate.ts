import { MAX_FILE_BYTES } from "./docx"
import { emptyCounts } from "./structures"
import { DOCX_TYPE } from "./types"

export async function validateDocx(blob: Blob, signal?: AbortSignal, prepare = false, expectedText?: string): Promise<Blob> {
  if (!blob.size || blob.size > MAX_FILE_BYTES) throw new Error("文件大小须在 20 MiB 以内。")
  const bytes = await blob.arrayBuffer()
  signal?.throwIfAborted()
  return new Promise<Blob>((resolve, reject) => {
    const worker = new Worker(new URL("./docx.worker.ts", import.meta.url))
    const finish = (error?: Error, prepared?: ArrayBuffer) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      worker.terminate()
      if (error) reject(error)
      else resolve(prepared ? new Blob([prepared], { type: DOCX_TYPE }) : blob)
    }
    const abort = () => finish(new Error("操作已取消。"))
    const timer = setTimeout(() => finish(new Error("DOCX 校验超时，请重试。")), 60000)
    signal?.addEventListener("abort", abort, { once: true })
    worker.onmessage = (event: MessageEvent<{ ok: boolean; message?: string; bytes?: ArrayBuffer }>) => finish(event.data.ok ? undefined : new Error(event.data.message ?? "DOCX 校验失败。"), event.data.bytes)
    worker.onerror = () => finish(new Error("无法校验 DOCX 文件，请重试。"))
    worker.postMessage({ bytes, prepare, expected: expectedText === undefined ? undefined : { text: expectedText, structures: emptyCounts() } }, [bytes])
  })
}
