import { prepareDocxBytes, validateDocxBytes } from "./docx"
import type { ExportExpectation } from "./structures"

self.onmessage = (event: MessageEvent<{ bytes: ArrayBuffer; prepare: boolean; expected?: ExportExpectation }>) => {
  try {
    const bytes = new Uint8Array(event.data.bytes)
    validateDocxBytes(bytes, event.data.expected)
    if (event.data.prepare) {
      const prepared = prepareDocxBytes(bytes)
      self.postMessage({ ok: true, bytes: prepared.buffer }, { transfer: [prepared.buffer as ArrayBuffer] })
    } else self.postMessage({ ok: true })
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : "DOCX 校验失败。" })
  }
}
