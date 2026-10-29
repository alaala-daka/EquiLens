import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildTaskManifest, encodeManifest, manifestHash, maxCallsFor, parseOperationId, parseTaskRequest,
  taskKinds, taskRequestDigest, type TaskKind,
} from "./catalog"
import { TaskError } from "./errors"
import { otherProjectId, validRequest } from "./test-fixtures"

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
    "collection-letter", "material-parse", "bid-verification", "result-export",
  ])
  for (const kind of taskKinds) {
    const parsed = parseTaskRequest(validRequest(kind))
    assert.equal(parsed.kind, kind)
    assert.equal(parsed.projectId, "project-1")
    assert.equal(maxCallsFor(kind), kind === "contract-review" ? 25 : kind === "document-analysis" || kind === "payment-reconciliation" || kind === "evidence-organization" || kind === "collection-letter" ? 3 : kind === "bid-verification" ? 2 : 0)
  }
})

test("A3a: unknown kinds and browser-supplied manifest/model/rules/executor are rejected", () => {
  submissionError(() => parseTaskRequest({ ...validRequest("contract-review"), kind: "arbitrary-agent" }))
  for (const extra of ["manifest", "model", "baseURL", "rules", "executor", "prompt", "maxCalls"]) {
    submissionError(() => parseTaskRequest({ ...validRequest("contract-review"), [extra]: "browser supplied" }))
  }
  submissionError(() => parseTaskRequest({
    ...validRequest("contract-review"),
    refs: { document: { projectId: "project-1", id: "document-1", versionId: "document-1-version" }, rules: "全文" },
  }))
  submissionError(() => parseTaskRequest({
    ...validRequest("contract-review"),
    conditions: { asOf: "2026-10-28", model: "https://model.invalid/v1" },
  }))
})

test("A3a: references from another project and malformed values are rejected", () => {
  submissionError(() => parseTaskRequest({
    kind: "contract-review", projectId: "project-1",
    refs: { document: { projectId: otherProjectId, id: "document-1", versionId: "document-1-version" } },
    conditions: {},
  }))
  submissionError(() => parseTaskRequest({ ...validRequest("material-parse"), refs: { materials: [{ materialVersionId: "m", sha256: "not-a-digest" }] } }))
  submissionError(() => parseTaskRequest({ ...validRequest("payment-reconciliation"), conditions: {} }))
  submissionError(() => parseTaskRequest({ kind: "result-export", projectId: "project-1", refs: { result: { projectId: "project-1", id: "r", versionId: "v" } }, conditions: { format: "pdf" } }))
})

test("A3a: operationId format is fixed and rejects missing/browser-selected ids", () => {
  assert.equal(parseOperationId("operation-1"), "operation-1")
  for (const value of [undefined, "", "short", "with space", "x".repeat(101)]) submissionError(() => parseOperationId(value))
})

test("A3a: request digest ignores key order and manifest is server-built and immutable", () => {
  const ordered = parseTaskRequest({ kind: "contract-review", projectId: "project-1", refs: { document: { projectId: "project-1", id: "document-1", versionId: "document-1-version" } }, conditions: {} })
  const reordered = parseTaskRequest({ conditions: {}, projectId: "project-1", refs: { document: { versionId: "document-1-version", id: "document-1", projectId: "project-1" } }, kind: "contract-review" })
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
  const changed = parseTaskRequest({ ...validRequest("contract-review"), conditions: { asOf: "2026-10-29" } })
  assert.notEqual(taskRequestDigest(ordered), taskRequestDigest(changed))
})

test("A3a: the catalogue version and fixed kinds stay in one place for consumers", () => {
  const kinds: TaskKind[] = [...taskKinds]
  assert.equal(new Set(kinds).size, kinds.length)
  assert.equal(taskKinds.includes("arbitrary-agent" as TaskKind), false)
})
