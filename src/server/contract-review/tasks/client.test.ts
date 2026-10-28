import assert from "node:assert/strict"
import { test } from "node:test"
import { downloadRevisedContract, listReviewTasks } from "../../../lib/contract-reviews/client"
import { DocumentSessionError, setDocumentContext } from "../../../lib/documents/client"

test("AC-01: review client sends context and rejects stale private responses before decoding", async t => {
  setDocumentContext("synthetic-context")
  let decoded = false
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("X-Document-Context"), "synthetic-context")
    const response = Response.json({ tasks: [] }, { headers: { "X-Document-Context": "other-context" } })
    response.json = async () => { decoded = true; return {} }
    return response
  })
  await assert.rejects(listReviewTasks(), failure => failure instanceof DocumentSessionError && failure.code === "SESSION_CHANGED")
  assert.equal(decoded, false)
})

test("AC-01/11: revised Word downloads reject a changed context before reading private bytes", async t => {
  setDocumentContext("synthetic-context")
  let decoded = false
  t.mock.method(globalThis, "fetch", async () => {
    const response = new Response("synthetic-docx", { headers: { "X-Document-Context": "other-context", "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } })
    response.blob = async () => { decoded = true; return new Blob(["synthetic"]) }
    return response
  })
  await assert.rejects(downloadRevisedContract("synthetic"), failure => failure instanceof DocumentSessionError && failure.code === "SESSION_CHANGED")
  assert.equal(decoded, false)
})

test("AC-01: review client preserves typed expiry errors for workspace revocation", async t => {
  setDocumentContext("synthetic-context")
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "资料保留期限已到期", code: "RETENTION_EXPIRED" }, { status: 410 }))
  await assert.rejects(listReviewTasks(), failure => failure instanceof DocumentSessionError && failure.code === "RETENTION_EXPIRED" && failure.status === 410)
})
