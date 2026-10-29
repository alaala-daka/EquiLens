import assert from "node:assert/strict"
import test from "node:test"
import { createProjectDocumentsClient, type ProjectDocumentView } from "./documents-client"
import { EditorAccessError } from "../documents/editor-access"

const view: ProjectDocumentView = {
  canEdit: true,
  document: { id: "d", projectId: "p", title: "合同", currentVersionId: "v", createdAt: "now", updatedAt: "now", materialId: "m", materialVersionId: "mv", copiedFrom: null },
  version: { id: "v", documentId: "d", parentId: null, sha256: "hash", createdAt: "now", editorVersion: "editor" },
}
const json = (value: unknown) => Response.json(value)
test("viewer can read and download while write preflight is locally denied", async () => {
  let requests = 0
  const client = createProjectDocumentsClient({ projectId: "p", isCurrent: () => true, canEdit: () => false, fetch: async path => {
    requests++
    return String(path).includes("download") ? new Response("saved") : json({ ...view, canEdit: false })
  } })
  assert.equal((await client.view("d")).canEdit, false)
  assert.equal(await (await client.download("d", "v")).text(), "saved")
  await assert.rejects(client.access.preflight("d", {}), { code: "ACCESS_DENIED" })
  assert.equal(requests, 2)
})
test("project editor opens exact saved bytes and maps immutable metadata", async () => {
  const paths: string[] = []
  const client = createProjectDocumentsClient({ projectId: "p", isCurrent: () => true, fetch: async (path, init) => {
    paths.push(String(path)); assert.equal(init?.cache, "no-store")
    return paths.length === 1 ? json(view) : new Response("docx")
  } })
  const opened = await client.access.open("d")
  assert.equal(paths[1], "/api/projects/p/documents/d/versions/v/content")
  assert.equal(await opened.revision.blob.text(), "docx")
  assert.equal(opened.document.currentRevision, "v")
  assert.equal(opened.revision.hash, "hash")
  assert.equal(opened.document.prompt, "")
})
test("readonly view does not fetch bytes into editable adapter", async () => {
  let calls = 0
  const client = createProjectDocumentsClient({ projectId: "p", isCurrent: () => true, fetch: async () => { calls++; return json({ ...view, canEdit: false }) } })
  await assert.rejects(client.access.open("d"), { code: "ACCESS_DENIED" })
  assert.equal(calls, 1)
})
for (const [status, code] of [[401, "SESSION_INVALID"], [403, "ACCESS_DENIED"], [409, "CONFLICT"], [503, "UNAVAILABLE"], [422, "FAILED"]] as const) {
  test(`HTTP ${status} maps to ${code}; access failures notify host`, async () => {
    let invalid = 0
    const client = createProjectDocumentsClient({ projectId: "p", isCurrent: () => true, onAccessInvalid: () => invalid++, fetch: async () => new Response("private", { status }) })
    await assert.rejects(client.access.preflight("d", {}), error => error instanceof EditorAccessError && error.code === code && !error.message.includes("private"))
    assert.equal(invalid, status === 401 || status === 403 ? 1 : 0)
  })
}
test("late response from old project is rejected before content request", async () => {
  let current = true
  const client = createProjectDocumentsClient({ projectId: "p", isCurrent: () => current, fetch: async () => { current = false; return json(view) } })
  await assert.rejects(client.access.open("d"), { code: "ABORTED" })
})
test("save preserves operation identity, parent and prompt then fetches returned version", async () => {
  let calls = 0
  const client = createProjectDocumentsClient({ projectId: "p", isCurrent: () => true, fetch: async (path, init) => {
    calls++
    if (calls === 1) {
      assert.equal(String(path), "/api/projects/p/documents/d/save")
      assert.deepEqual(JSON.parse(String(init?.body)), { baseVersionId: "v", operationId: "op", title: "合同", prompt: "备注", editorVersion: "superdoc@1.47.2", blob: btoa("bytes") })
      return json({ ...view, version: { ...view.version, id: "saved", parentId: "v" } })
    }
    assert.equal(String(path), "/api/projects/p/documents/d/versions/saved/content")
    return new Response("saved bytes")
  } })
  const saved = await client.access.save({ documentId: "d", baseRevision: "v", operationId: "op", title: "合同", prompt: "备注", blob: new Blob(["bytes"]) })
  assert.equal(saved.revision.parentId, "v")
  assert.equal(await saved.revision.blob.text(), "saved bytes")
})
test("readonly download authorizes selected version over HTTP", async () => {
  const client = createProjectDocumentsClient({ projectId: "p", isCurrent: () => true, fetch: async path => { assert.equal(String(path), "/api/projects/p/documents/d/download?versionId=v"); return new Response("saved") } })
  assert.equal(await (await client.download("d", "v")).text(), "saved")
})

test("copy retry after lost content response retains operation identity and source version", async () => {
  const operations: string[] = []
  let contents = 0
  const client = createProjectDocumentsClient({ projectId: "p", isCurrent: () => true, fetch: async (path, init) => {
    if (String(path).endsWith("/copy")) {
      const body = JSON.parse(String(init?.body))
      operations.push(body.operationId)
      assert.equal(body.baseVersionId, "v")
      assert.equal(String(path), "/api/projects/p/documents/d/copy")
      return json(view)
    }
    if (++contents === 1) throw new Error("lost response")
    return new Response("copy bytes")
  } })
  const input = { title: "副本", source: "copy" as const, blob: new Blob(["bytes"]), copiedFrom: { documentId: "d", revisionId: "v" } }
  await assert.rejects(client.access.copy(input), { code: "FAILED" })
  assert.equal(await (await client.access.copy(input)).revision.blob.text(), "copy bytes")
  assert.equal(operations.length, 2)
  assert.equal(operations[0], operations[1])
})
