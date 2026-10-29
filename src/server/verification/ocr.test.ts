import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { createOcrAdapter, createUnavailableOcrAdapter, isOcrError, OcrError } from "./ocr"
import { createSyntheticOcrAdapter, imageOfSize, jpegImage, pngImage, syntheticCertificateFields } from "./ocr-test-fixtures"
import { inspectImage, parseImageMaterial, IMAGE_LIMITS, ParseFailure } from "../materials/parse"

/**
 * C4-OCR adapter boundary tests.
 *
 * The production factory is fail-closed: without a verified provider and a
 * measured certificate-kind list it returns an unavailable adapter, and even a
 * fully-populated environment stays closed until a real adapter is implemented
 * and reviewed. The synthetic adapter is a test fixture only; the last test in
 * this file proves production modules never import it.
 */

const repoRoot = process.cwd()

const request = (bytes: Uint8Array) => ({
  projectId: "11111111-1111-4111-8111-111111111111",
  materialId: "22222222-2222-4222-8222-222222222222",
  versionId: "33333333-3333-4333-8333-333333333333",
  certificateKind: "营业执照",
  bytes,
  contentType: "image/png",
  sha256: "a".repeat(64),
  signal: new AbortController().signal,
})

test("C4-OCR: production adapter is fail-closed without verified configuration", async () => {
  for (const env of [{}, { OCR_ENDPOINT: "https://ocr.invalid" }, { OCR_ENDPOINT: "https://ocr.invalid", OCR_SUPPORTED_KINDS: " " }]) {
    const adapter = createOcrAdapter(env)
    assert.equal(adapter.available(), false)
    assert.deepEqual([...adapter.supportedKinds()], [])
    await assert.rejects(adapter.recognize(request(pngImage(10, 10))), (failure: unknown) => {
      assert.ok(isOcrError(failure))
      assert.equal((failure as OcrError).code, "OCR_UNAVAILABLE")
      return true
    })
  }
})

test("C4-OCR: a configured endpoint alone never opens image/OCR capability", async () => {
  const adapter = createOcrAdapter({
    OCR_ENDPOINT: "https://ocr.invalid",
    OCR_ACCESS_KEY_ID: "synthetic-id",
    OCR_ACCESS_KEY_SECRET: "synthetic-secret",
    OCR_REGION: "cn-north-4",
    OCR_SUPPORTED_KINDS: "营业执照",
  })
  assert.equal(adapter.available(), false)
  assert.deepEqual([...adapter.supportedKinds()], [])
  // The failure reason names what is missing but never returns a value or credential.
  await assert.rejects(adapter.recognize(request(pngImage(10, 10))), (failure: unknown) => {
    assert.ok(isOcrError(failure))
    assert.equal((failure as OcrError).code, "OCR_UNAVAILABLE")
    assert.doesNotMatch((failure as Error).message, /synthetic-secret|https:\/\/ocr\.invalid/)
    return true
  })
})

test("C4-OCR: unavailable adapter factory reports its reason and no supported kind", async () => {
  const adapter = createUnavailableOcrAdapter("OCR 未验证")
  assert.equal(adapter.available(), false)
  assert.deepEqual([...adapter.supportedKinds()], [])
  await assert.rejects(adapter.recognize(request(pngImage(1, 1))), /OCR 未验证/)
})

test("C4-OCR test fixture: synthetic adapter is deterministic and only a test double", async () => {
  const adapter = createSyntheticOcrAdapter()
  assert.equal(adapter.available(), true)
  assert.ok(adapter.supportedKinds().includes("营业执照"))
  const extraction = await adapter.recognize(request(pngImage(640, 480)))
  assert.equal(adapter.calls, 1)
  assert.equal(extraction.provider, "synthetic-ocr")
  assert.equal(extraction.image.width, 640)
  assert.equal(extraction.image.height, 480)
  assert.deepEqual(extraction.fields.map(field => field.fieldKey), syntheticCertificateFields.map(field => field.fieldKey))
  assert.equal(extraction.usage.calls, 1)

  const failing = createSyntheticOcrAdapter({ failures: 2, failureCode: "OCR_FAILED" })
  await assert.rejects(failing.recognize(request(pngImage(10, 10))))
  await assert.rejects(failing.recognize(request(pngImage(10, 10))))
  assert.equal(failing.calls, 2)
  const recovered = await failing.recognize(request(pngImage(10, 10)))
  assert.equal(recovered.provider, "synthetic-ocr")
})

test("C4-OCR: image fixtures are real PNG/JPEG content with readable dimensions", () => {
  assert.deepEqual(inspectImage(pngImage(1024, 768)), { format: "png", width: 1024, height: 768 })
  assert.deepEqual(inspectImage(jpegImage(2048, 4096)), { format: "jpeg", width: 2048, height: 4096 })
  assert.equal(inspectImage(new TextEncoder().encode("not an image")), null)
  assert.equal(inspectImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), null)
  // Type forgery: PDF bytes renamed to .png are not recognized as images.
  assert.equal(inspectImage(new TextEncoder().encode("%PDF-1.4 fake")), null)
})

test("C4-OCR image limits: 4 MiB, 8192 px side and 40 MP are enforced with one product message", () => {
  const ok = pngImage(8192, 4882) // 39,993,344 px
  assert.equal(parseImageMaterial(ok).width, 8192)
  const cases: Uint8Array[] = [
    imageOfSize(pngImage(10, 10), IMAGE_LIMITS.fileBytes + 1),
    pngImage(IMAGE_LIMITS.sidePixels + 1, 1),
    pngImage(1, IMAGE_LIMITS.sidePixels + 1),
    pngImage(8192, 4883), // 40,001,536 px
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]),
  ]
  for (const bytes of cases) {
    assert.throws(() => parseImageMaterial(bytes), (failure: unknown) => {
      assert.ok(failure instanceof ParseFailure)
      assert.equal(failure.message, "证照图片需为 4 MiB 以内的 PNG 或 JPEG，单边不超过 8192 像素且总像素不超过 4000 万。")
      return true
    })
  }
})

test("C4-OCR: production modules never import the synthetic OCR fixture", () => {
  const productionFiles = [
    "src/server/verification/ocr.ts",
    "src/server/verification/ocr-runtime.ts",
    "src/server/verification/ocr-executor.ts",
    "src/server/verification/ocr-repository.ts",
    "src/server/materials/runtime.ts",
    "src/server/materials/http-runtime.ts",
    "src/server/materials/http.ts",
    "src/server/materials/queued.ts",
    "src/server/materials/service.ts",
    "src/server/materials/executor.ts",
    "src/instrumentation.ts",
    "src/app/api/projects/[id]/materials/[materialId]/versions/[versionId]/fields/route.ts",
  ]
  for (const file of productionFiles) {
    const source = readFileSync(join(repoRoot, file), "utf8")
    // Only real imports matter; comments may name the fixture to explain the boundary.
    assert.doesNotMatch(source, /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*ocr-test-fixtures/, `${file} must not import the synthetic OCR fixture`)
    assert.doesNotMatch(source, /createSyntheticOcrAdapter\s*\(/, `${file} must not construct the synthetic OCR adapter`)
  }
  // The fixture is only reachable from tests and files named ocr*-test-fixtures.ts.
  const fixture = readFileSync(join(repoRoot, "src/server/verification/ocr-test-fixtures.ts"), "utf8")
  assert.match(fixture, /TEST-ONLY/)
})
