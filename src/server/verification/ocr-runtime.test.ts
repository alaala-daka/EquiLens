import assert from "node:assert/strict"
import { test } from "node:test"
import { taskAdmission } from "../tasks/admission"
import { taskExecutorRegistry } from "../tasks/executors"
import { isTaskError } from "../tasks/errors"
import type { TaskExecutor } from "../tasks/runner-core"
import { createUnavailableOcrAdapter } from "./ocr"
import { createSyntheticOcrAdapter } from "./ocr-test-fixtures"
import { registerCertificateOcrCapability } from "./ocr-executor"

/**
 * C4-OCR lifecycle registration tests.
 *
 * Registration happens in the explicit Node lifecycle (ocr-runtime.ts, which is
 * server-only) and never touches the database or object storage. Capability is
 * fail-closed: with an unavailable adapter no `certificate-ocr` executor exists,
 * so POST /api/tasks answers 503 before persistence. With a verified adapter the
 * kind admission hook rejects unmeasured certificate kinds with 422.
 */
const fakeExecutor: TaskExecutor = async () => ({ outcome: "failed", errorCode: "TEST_EXECUTOR", errorMessage: "test" })

const input = (certificateKind: string) => ({
  kind: "certificate-ocr" as const,
  projectId: "11111111-1111-4111-8111-111111111111",
  refs: { materials: [{ materialVersionId: "22222222-2222-4222-8222-222222222222", sha256: "a".repeat(64) }] },
  conditions: { certificateKind, externalProcessingConsent: true },
})

test("C4-OCR: unavailable adapter registers no certificate-ocr executor; admission answers 503", async () => {
  const registered = registerCertificateOcrCapability(createUnavailableOcrAdapter("OCR 未验证"), () => fakeExecutor)
  assert.equal(registered, false)
  assert.equal(taskExecutorRegistry.get("certificate-ocr"), null)
  const admission = taskAdmission("certificate-ocr")
  assert.ok(admission)
  await assert.rejects(admission(input("营业执照")), (failure: unknown) => {
    assert.ok(isTaskError(failure))
    assert.equal((failure as { status: number }).status, 503)
    return true
  })
})

test("C4-OCR: verified adapter registers one executor and rejects unmeasured kinds with 422", async () => {
  const registered = registerCertificateOcrCapability(createSyntheticOcrAdapter({ kinds: ["营业执照"] }), () => fakeExecutor)
  assert.equal(registered, true)
  assert.equal(taskExecutorRegistry.get("certificate-ocr"), fakeExecutor)
  const admission = taskAdmission("certificate-ocr")
  assert.ok(admission)
  await admission(input("营业执照"))
  await assert.rejects(admission(input("人员资格证书")), (failure: unknown) => {
    assert.ok(isTaskError(failure))
    assert.equal((failure as { status: number }).status, 422)
    assert.equal((failure as { code: string }).code, "INVALID_SUBMISSION")
    return true
  })
})

test("C4-OCR: an available adapter with no measured certificate kind keeps the kind closed", () => {
  const registered = registerCertificateOcrCapability(createSyntheticOcrAdapter({ kinds: [] }), () => fakeExecutor)
  assert.equal(registered, false)
})
