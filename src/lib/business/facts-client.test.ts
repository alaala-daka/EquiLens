import assert from "node:assert/strict"
import { test } from "node:test"
import { createProjectFactsClient } from "./facts-client"
import type { SaveProjectFact } from "../facts/types"

const input: SaveProjectFact = { operationId: "same-operation", baseVersionId: "", reason: "人工登记", value: { field: "付款日期", nature: "人工陈述", selectedValue: "2026-10-30", confirmation: "待核实", support: "仅人工陈述", sources: [], conflicts: [] } }
test("facts client binds project paths, saves only drafts, and submits bounded task conditions", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = createProjectFactsClient({ projectId: "project/a", isCurrent: () => true, fetch: async (url, init) => {
    calls.push({ url: String(url), init })
    return Response.json(String(url) === "/api/tasks" ? { task: { id: "prepared" }, created: true } : { fact: { factId: "saved" }, facts: [], versions: [] })
  } })
  await client.list(); await client.history("fact/a"); await client.save(input)
  await client.prepare([{ materialVersionId: "v1", sha256: "a".repeat(64) }], "task-op")
  assert.equal(calls[0].url, "/api/projects/project%2Fa/facts")
  assert.equal(calls[1].url, "/api/projects/project%2Fa/facts/fact%2Fa")
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), input)
  const task = JSON.parse(String(calls[3].init?.body))
  assert.equal(task.kind, "document-analysis")
  assert.deepEqual(task.conditions, { externalProcessingConsent: true })
  assert.equal((calls[3].init?.headers as Record<string, string>)["Idempotency-Key"], "task-op")
})
test("facts client blocks viewer writes and invalidates access on revoked membership", async () => {
  let calls = 0; let revoked = false
  const client = createProjectFactsClient({ projectId: "p", isCurrent: () => true, canEdit: () => false, onAccessInvalid: () => { revoked = true }, fetch: async () => { calls++; return Response.json({ error: { code: "FORBIDDEN", message: "无权访问项目。" } }, { status: 403 }) } })
  await assert.rejects(client.save(input), { code: "ACCESS_DENIED" })
  assert.equal(calls, 0)
  await assert.rejects(client.list(), { code: "ACCESS_DENIED" })
  assert.equal(revoked, true)
})
test("facts client drops late responses after project switch and preserves conflict code", async () => {
  let current = true
  const client = createProjectFactsClient({ projectId: "p", isCurrent: () => current, fetch: async () => { current = false; return Response.json({ facts: [{ factId: "private" }] }) } })
  await assert.rejects(client.list(), { code: "ABORTED" })
  const conflict = createProjectFactsClient({ projectId: "p", isCurrent: () => true, fetch: async () => Response.json({ error: { code: "CONFLICT", message: "事实版本已变化。" } }, { status: 409 }) })
  await assert.rejects(conflict.save(input), { code: "CONFLICT", serverCode: "CONFLICT" })
})
