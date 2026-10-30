import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildTaskManifest, encodeManifest, manifestHash, maxCallsFor, parseOperationId, parseTaskRequest,
  TASK_CATALOG_VERSION, taskKinds, taskRequestDigest, type TaskKind,
} from "./catalog"
import { TaskError } from "./errors"
import { otherProjectId, reviewConditions, validRequest } from "./test-fixtures"

function submissionError(work: () => unknown) {
  try { work() } catch (failure) {
    assert.ok(failure instanceof TaskError, "expected a TaskError")
    assert.equal(failure.status, 422)
    assert.equal(failure.code, "INVALID_SUBMISSION")
    return failure
  }
  assert.fail("expected the submission to be rejected")
}

test("A3a: every controlled task kind has a server-fixed schema", () => {
  assert.deepEqual([...taskKinds], [
    "contract-review", "document-analysis", "payment-reconciliation", "evidence-organization",
    "collection-letter", "material-parse", "bid-requirements", "certificate-ocr", "bid-verification", "result-export",
  ])
  const expectedCalls: Record<TaskKind, number> = {
    "contract-review": 25, "document-analysis": 3, "payment-reconciliation": 3, "evidence-organization": 3,
    "collection-letter": 3, "material-parse": 0, "bid-requirements": 2, "certificate-ocr": 2,
    "bid-verification": 0, "result-export": 0,
  }
  for (const kind of taskKinds) {
    const parsed = parseTaskRequest(validRequest(kind))
    assert.equal(parsed.kind, kind)
    assert.equal(parsed.projectId, "project-1")
    assert.equal(maxCallsFor(kind), expectedCalls[kind])
  }
})

test("B1a: fact preparation pins one to five material versions and explicit external consent", () => {
  for (const count of [1, 5]) {
    const refs = { materials: Array.from({ length: count }, (_, i) => ({ materialVersionId: `m-${i}`, sha256: "a".repeat(64) })) }
    assert.equal((parseTaskRequest({ ...validRequest("document-analysis"), refs }).refs.materials as unknown[]).length, count)
  }
  submissionError(() => parseTaskRequest({ ...validRequest("document-analysis"), conditions: {} }))
  submissionError(() => parseTaskRequest({ ...validRequest("document-analysis"), refs: { materials: [] } }))
  submissionError(() => parseTaskRequest({ ...validRequest("document-analysis"), refs: { materials: Array.from({ length: 6 }, (_, i) => ({ materialVersionId: `m-${i}`, sha256: "a".repeat(64) })) } }))
})

test("C4: bid task schemas pin records/asOf/one-image and reject the superseded shape", () => {
  // The old two-call single bid-verification shape must not be accepted any more.
  submissionError(() => parseTaskRequest({
    kind: "bid-verification", projectId: "project-1",
    refs: { materials: [{ materialVersionId: "material-1", sha256: "a".repeat(64) }] },
    conditions: { asOf: "2026-10-28" },
  }))
  // Comparison requires an explicit as-of point and a pinned requirement set.
  submissionError(() => parseTaskRequest({
    kind: "bid-verification", projectId: "project-1",
    refs: { materials: [{ materialVersionId: "material-1", sha256: "a".repeat(64) }], requirementSet: { id: "r", versionId: "v", sha256: "a".repeat(64) } },
    conditions: {},
  }))
  // Certificate OCR is exactly one image version per task.
  submissionError(() => parseTaskRequest({
    kind: "certificate-ocr", projectId: "project-1",
    refs: { materials: [{ materialVersionId: "a", sha256: "a".repeat(64) }, { materialVersionId: "b", sha256: "a".repeat(64) }] },
    conditions: { certificateKind: "enterprise_license", externalProcessingConsent: true },
  }))
  // A deterministic comparison must not accept outbound-processing fields.
  submissionError(() => parseTaskRequest({
    kind: "bid-verification", projectId: "project-1",
    refs: { materials: [{ materialVersionId: "material-1", sha256: "a".repeat(64) }], requirementSet: { id: "r", versionId: "v", sha256: "a".repeat(64) } },
    conditions: { asOf: "2026-10-28", externalProcessingConsent: true },
  }))
  // Pinned records are part of the request identity and must be well formed.
  const pinned = parseTaskRequest({
    kind: "bid-verification", projectId: "project-1",
    refs: {
      materials: [{ materialVersionId: "material-1", sha256: "a".repeat(64) }],
      requirementSet: { id: "r", versionId: "v", sha256: "a".repeat(64) },
      externalRecords: [{ recordId: "record-1", sha256: "b".repeat(64) }],
    },
    conditions: { asOf: "2026-10-28" },
  })
  assert.equal(taskRequestDigest(pinned), taskRequestDigest(parseTaskRequest({
    kind: "bid-verification", projectId: "project-1",
    refs: {
      materials: [{ materialVersionId: "material-1", sha256: "a".repeat(64) }],
      requirementSet: { id: "r", versionId: "v", sha256: "a".repeat(64) },
      externalRecords: [{ recordId: "record-1", sha256: "b".repeat(64) }],
    },
    conditions: { asOf: "2026-10-28" },
  })))
  submissionError(() => parseTaskRequest({
    kind: "bid-verification", projectId: "project-1",
    refs: { materials: [{ materialVersionId: "material-1", sha256: "a".repeat(64) }], requirementSet: { id: "r", versionId: "v", sha256: "a".repeat(64) }, externalRecords: [{ recordId: "record-1", sha256: "not-a-digest" }] },
    conditions: { asOf: "2026-10-28" },
  }))
  assert.equal(TASK_CATALOG_VERSION, 5)
})

test("R5: server-resolved publications are pinned into the manifest and never accepted from the browser", () => {
  const request = parseTaskRequest(validRequest("contract-review"))
  const pin = {
    rules: [{ id: "rule-pack", versionId: "v1", sha256: "a".repeat(64) }],
    knowledge: [],
    templates: [],
  }
  const manifest = buildTaskManifest(request, "account-1", "2026-10-29T00:00:00.000Z", pin)
  assert.deepEqual(manifest.publications, pin)
  assert.equal(encodeManifest(manifest), encodeManifest({ ...manifest, publications: { ...pin } }))
  const debugManifest = buildTaskManifest(request, "account-1", "2026-10-29T00:00:00.000Z")
  assert.equal("publications" in debugManifest, false)
  // Browser input cannot claim a published basis; only the server resolver may add it.
  submissionError(() => parseTaskRequest({ ...validRequest("contract-review"), publications: pin }))
  submissionError(() => parseTaskRequest({
    ...validRequest("contract-review"),
    conditions: { ...reviewConditions, publications: pin },
  }))
  // Idempotency stays keyed on the browser request, so a pin change never creates a new identity.
  assert.equal(taskRequestDigest(request), taskRequestDigest(parseTaskRequest(validRequest("contract-review"))))
})

test("A3a: unknown kinds and browser-supplied manifest/model/rules/executor are rejected", () => {
  submissionError(() => parseTaskRequest({ ...validRequest("contract-review"), kind: "arbitrary-agent" }))
  for (const extra of ["manifest", "model", "baseURL", "rules", "executor", "prompt", "maxCalls"]) {
    submissionError(() => parseTaskRequest({ ...validRequest("contract-review"), [extra]: "browser supplied" }))
  }
  submissionError(() => parseTaskRequest({
    ...validRequest("contract-review"),
    refs: { materials: [{ materialVersionId: "material-1", sha256: "a".repeat(64) }], rules: "全文" },
  }))
  submissionError(() => parseTaskRequest({
    ...validRequest("contract-review"),
    conditions: { ...reviewConditions, model: "https://model.invalid/v1" },
  }))
})

test("A3a: references from another project and malformed values are rejected", () => {
  submissionError(() => parseTaskRequest({
    kind: "document-analysis", projectId: "project-1",
    refs: { document: { projectId: otherProjectId, id: "document-1", versionId: "document-1-version" } },
    conditions: {},
  }))
  submissionError(() => parseTaskRequest({ ...validRequest("contract-review"), refs: { materials: [{ materialVersionId: "material-1", sha256: "not-a-digest" }] } }))
  submissionError(() => parseTaskRequest({ ...validRequest("contract-review"), conditions: { ...reviewConditions, externalProcessingConsent: false } }))
  submissionError(() => parseTaskRequest({ ...validRequest("material-parse"), refs: { materials: [{ materialVersionId: "m", sha256: "not-a-digest" }] } }))
  submissionError(() => parseTaskRequest({ ...validRequest("payment-reconciliation"), conditions: {} }))
  submissionError(() => parseTaskRequest({ kind: "result-export", projectId: "project-1", refs: { result: { projectId: "project-1", id: "r", versionId: "v" } }, conditions: { format: "pdf" } }))
})

test("A3a: operationId format is fixed and rejects missing/browser-selected ids", () => {
  assert.equal(parseOperationId("operation-1"), "operation-1")
  for (const value of [undefined, "", "short", "with space", "x".repeat(101)]) submissionError(() => parseOperationId(value))
})

test("A3a: request digest ignores key order and manifest is server-built and immutable", () => {
  const ordered = parseTaskRequest(validRequest("contract-review"))
  const reordered = parseTaskRequest({ conditions: { region: "上海", scene: "auto", role: "专业分包人", unreviewedMaterialsConsent: true, externalProcessingConsent: true }, projectId: "project-1", refs: { materials: [{ sha256: "a".repeat(64), materialVersionId: "material-1" }] }, kind: "contract-review" })
  assert.equal(taskRequestDigest(ordered), taskRequestDigest(reordered))
  const manifest = buildTaskManifest(ordered, "account-1", "2026-10-28T00:00:00.000Z")
  assert.equal(manifest.version, 1)
  assert.equal(manifest.kind, "contract-review")
  assert.equal(manifest.projectId, "project-1")
  assert.equal(manifest.submittedBy, "account-1")
  const encoded = encodeManifest(manifest)
  assert.equal(encodeManifest({ ...manifest, refs: { ...manifest.refs } }), encoded)
  assert.equal(manifestHash(encoded), manifestHash(encodeManifest(manifest)))
  assert.equal(encoded.includes("executor"), false)
  // A changed input changes the digest, which the repository treats as a conflict.
  const changed = parseTaskRequest({ ...validRequest("contract-review"), conditions: { ...reviewConditions, asOf: "2026-10-29" } })
  assert.notEqual(taskRequestDigest(ordered), taskRequestDigest(changed))
})

test("A3a: the catalogue version and fixed kinds stay in one place for consumers", () => {
  const kinds: TaskKind[] = [...taskKinds]
  assert.equal(new Set(kinds).size, kinds.length)
  assert.equal(taskKinds.includes("arbitrary-agent" as TaskKind), false)
})
