import { prepareDocxBytes, validateDocxBytes } from "./docx"
import type { ExportExpectation } from "./structures"

export type DocxWorkerRequest = { bytes: ArrayBuffer; prepare: boolean; expected?: ExportExpectation }
export type DocxWorkerResponse = { ok: boolean; message?: string; bytes?: ArrayBuffer }

self.onmessage = (event: MessageEvent<DocxWorkerRequest>) => {
  try {
    const bytes = new Uint8Array(event.data.bytes)
    validateDocxBytes(bytes, event.data.expected)
    if (event.data.prepare) {
      const prepared = prepareDocxBytes(bytes)
      const buffer = prepared.buffer as ArrayBuffer
      self.postMessage({ ok: true, bytes: buffer } satisfies DocxWorkerResponse, { transfer: [buffer] })
    } else self.postMessage({ ok: true } satisfies DocxWorkerResponse)
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : "DOCX 校验失败。" } satisfies DocxWorkerResponse)
  }
}
