import { inspectImage, type ImageInspection } from "../materials/parse"
import {
  isOcrError, OcrError, type OcrAdapter, type OcrErrorCode, type OcrExtraction, type OcrExtractedField,
  type OcrImageInfo, type OcrRequest,
} from "./ocr"

/**
 * TEST-ONLY OCR fixtures.
 *
 * The synthetic adapter, synthetic certificate field values and synthetic image
 * bytes live here and nowhere else. Production modules (`ocr.ts`,
 * `ocr-runtime.ts`, `ocr-executor.ts`, materials runtime/wiring) must never
 * import this file; `ocr.test.ts` asserts that by scanning their imports and by
 * proving the production factory is fail-closed with a synthetic-looking env.
 * Nothing here is a claim that any certificate kind was measured against a real
 * provider.
 */

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function uint32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes)
  body.set(data, typeBytes.length)
  const crc = crc32(body)
  const chunk = new Uint8Array(4 + body.length + 4)
  chunk.set(uint32be(data.length))
  chunk.set(body, 4)
  chunk.set(uint32be(crc), 4 + body.length)
  return chunk
}

/** Minimal structurally valid PNG header (IHDR) with the requested dimensions. */
export function pngImage(width: number, height: number): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array(13)
  ihdr.set(uint32be(width), 0)
  ihdr.set(uint32be(height), 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const idat = new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])
  const parts = [signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array())]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

/** Minimal JPEG with an APP0 segment and a real SOF0 frame carrying the dimensions. */
export function jpegImage(width: number, height: number): Uint8Array {
  const parts: Uint8Array[] = [
    new Uint8Array([0xff, 0xd8]),
    new Uint8Array([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]
  const sof = new Uint8Array([0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  parts.push(sof, new Uint8Array([0xff, 0xd9]))
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

/** Wrap valid image bytes in trailing padding to exercise the byte-size limit. */
export function imageOfSize(bytes: Uint8Array, size: number): Uint8Array {
  if (size < bytes.length) throw new Error("Size is smaller than the source image")
  const out = new Uint8Array(size)
  out.set(bytes)
  return out
}

/** A preview of the frozen field vocabulary as synthetic certificate values (tests only). */
export const syntheticCertificateFields: OcrExtractedField[] = [
  { fieldKey: "subject_name", valueText: "合成测试建设有限公司", confidence: 96 },
  { fieldKey: "unified_social_credit_code", valueText: "91310000MA1K000000", confidence: 94 },
  { fieldKey: "certificate_kind", valueText: "建筑业企业资质证书", confidence: 93 },
  { fieldKey: "certificate_level", valueText: "一级", confidence: 91 },
  { fieldKey: "certificate_number", valueText: "D131000000", confidence: 92 },
  { fieldKey: "issue_date", valueText: "2024年1月2日", confidence: 90 },
  { fieldKey: "expiry_date", valueText: "2027-01-01", confidence: 90 },
]

export type SyntheticOcrAdapterOptions = {
  kinds?: readonly string[]
  fields?: OcrExtractedField[]
  text?: string | null
  /** Number of leading recognize calls that reject with an OcrError. */
  failures?: number
  failureCode?: OcrErrorCode
  provider?: string
  providerVersion?: string
  image?: OcrImageInfo
  delayMs?: number
}

export type SyntheticOcrAdapter = OcrAdapter & {
  readonly calls: number
  readonly requests: readonly OcrRequest[]
}

/** In-memory adapter for tests; never registered by production wiring. */
export function createSyntheticOcrAdapter(options: SyntheticOcrAdapterOptions = {}): SyntheticOcrAdapter {
  const kinds = options.kinds ?? ["营业执照", "建筑业企业资质证书", "安全生产许可证"]
  let calls = 0
  const requests: OcrRequest[] = []
  return {
    available: () => true,
    supportedKinds: () => kinds,
    get calls() { return calls },
    get requests() { return requests },
    async recognize(request: OcrRequest): Promise<OcrExtraction> {
      calls += 1
      requests.push(request)
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      if (request.signal.aborted) throw new OcrError("OCR_TIMEOUT", "OCR 请求已取消。")
      if (calls <= (options.failures ?? 0)) throw new OcrError(options.failureCode ?? "OCR_FAILED", "OCR 服务请求失败。")
      const image: OcrImageInfo = options.image ?? inspectImage(request.bytes) ?? { format: "png", width: 800, height: 600 }
      return {
        provider: options.provider ?? "synthetic-ocr",
        providerVersion: options.providerVersion ?? "synthetic-1",
        requestId: `synthetic-${request.materialId}-${calls}`,
        image,
        fields: (options.fields ?? syntheticCertificateFields).map(field => ({ ...field })),
        text: options.text ?? null,
        usage: { calls: 1, costFen: 1, timeMs: options.delayMs ?? 5 },
      }
    },
  }
}

export function isOcrFixtureError(value: unknown): boolean {
  return isOcrError(value)
}

export function dimensionsOf(bytes: Uint8Array): ImageInspection | null {
  return inspectImage(bytes)
}
