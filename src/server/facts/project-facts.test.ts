import assert from "node:assert/strict"
import { test } from "node:test"
import { NextRequest } from "next/server"
import type { ProjectFactDraft, SaveProjectFact } from "@/lib/facts/types"
import { projectId, accountId, setupReview, testIdentity, testAuthorizer, executorContext, type ReviewFixture } from "../reviews/test-fixtures"
import { BusinessError } from "../projects/errors"
import { ResultRepository } from "../results/repository"
import { ResultService } from "../results/service"
import { ResultValidatorRegistry } from "../results/validation"
import { FactRepository } from "./repository"
import { FactService } from "./service"
import { factsHandler } from "./http"
import { createFactsExecutor, type FactsExecutorDependencies } from "./executor"
import { factCandidatesValidator, type FactCandidatesValue } from "./result-validator"
import { createFactExtractor } from "./extractor"

const source = (f: ReviewFixture) => ({ projectId, materialId: f.materials[0].materialId, materialVersionId: f.materials[0].versionId,
  parseSnapshotId: f.materials[0].snapshotId, fragmentId: "fragment-1-0", quote: "合同价款按月度计量支付。" })
const draft = (f: ReviewFixture): ProjectFactDraft => ({ field: "支付方式", nature: "材料记载", originalValue: "按月计量", selectedValue: "按月计量", confirmation: "已确认", support: "材料支持", sources: [source(f)], conflicts: [] })
const request = (f: ReviewFixture): SaveProjectFact => ({ operationId: "save-fact", baseVersionId: "", reason: "核对材料", value: draft(f) })
function service(f: ReviewFixture) { return new FactService({ facts: new FactRepository(f.database), materials: f.repository, readProjectRetention: async () => f.projectRetention }) }

test("AC-06/19/22: project facts save idempotently, keep immutable history, reject stale concurrent corrections", async () => {
  const f = await setupReview()
  try {
    const s = service(f), input = request(f)
    const first = await s.save(testIdentity, testAuthorizer, projectId, input)
    assert.equal((await s.save(testIdentity, testAuthorizer, projectId, input)).factVersionId, first.factVersionId)
    await assert.rejects(s.save(testIdentity, testAuthorizer, projectId, { ...input, reason: "different" }), { code: "CONFLICT" })
    const correction = { ...input, factId: first.factId, baseVersionId: first.factVersionId, reason: "人工核实不同口径", value: { ...input.value, selectedValue: "每月核对" } }
    const responses = await Promise.allSettled([s.save(testIdentity, testAuthorizer, projectId, { ...correction, operationId: "correct-a" }), s.save(testIdentity, testAuthorizer, projectId, { ...correction, operationId: "correct-b" })])
    assert.equal(responses.filter(value => value.status === "fulfilled").length, 1)
    const history = await s.history(testIdentity, testAuthorizer, projectId, first.factId)
    assert.deepEqual(history.map(fact => fact.version), [2, 1])
    assert.equal(history[1].selectedValue, "按月计量")
    await assert.rejects(s.history(testIdentity, testAuthorizer, "another-project", first.factId), { code: "NOT_FOUND" })
  } finally { await f.close() }
})

test("AC-15/19/24: project facts recheck source ownership, quote, snapshot, consent and retention", async () => {
  const f = await setupReview()
  try {
    const s = service(f)
    for (const change of [{ quote: "编造文字" }, { projectId: "another-project" }, { parseSnapshotId: "other-snapshot" }, { materialVersionId: "other-version" }])
      await assert.rejects(s.save(testIdentity, testAuthorizer, projectId, { ...request(f), value: { ...draft(f), sources: [{ ...source(f), ...change }] } }), { code: "INVALID_SOURCE" })
    await f.database.transaction(c => c.query("UPDATE equilens_materials SET processing_authorized=0 WHERE id=$1", [f.materials[0].materialId]))
    await assert.rejects(s.save(testIdentity, testAuthorizer, projectId, request(f)), { code: "INVALID_SOURCE" })
    await f.database.transaction(c => c.query("UPDATE equilens_materials SET processing_authorized=1,retention_until=$1 WHERE id=$2", ["2000-01-01", f.materials[0].materialId]))
    await assert.rejects(s.save(testIdentity, testAuthorizer, projectId, request(f)), { code: "INVALID_SOURCE" })
    await assert.rejects(s.save(testIdentity, async (identity, id, action) => ({ projectId: id, action, role: "viewer", identity }), projectId, request(f)), { code: "FORBIDDEN" })
    await assert.rejects(s.save(testIdentity, async () => { throw new BusinessError("FORBIDDEN", "无权操作。") }, projectId, request(f)), { code: "FORBIDDEN" })
  } finally { await f.close() }
})

test("AC-19: normalization preserves supported quotes; confirmed conflicts remain conflicts", async () => {
  const f = await setupReview({ fragments: ["合同价款按月度\n计量支付。"] })
  try {
    const second = await f.addMaterial(["结算按季度核对。"])
    const s = service(f)
    const saved = await s.save(testIdentity, testAuthorizer, projectId, { ...request(f), value: { ...draft(f), sources: [{ ...source(f), quote: "合同价款按月度 计量支付。" }], conflicts: [{ ...source(f), materialId: second.materialId, materialVersionId: second.versionId, parseSnapshotId: second.snapshotId, fragmentId: "fragment-2-0", quote: "结算按季度核对。" }], support: "材料冲突" } })
    assert.equal(saved.evidenceStatus, "材料冲突")
    assert.equal(saved.confirmation, "已确认")
  } finally { await f.close() }
})

test("AC-15: facts HTTP protects read/write roles, same-origin, body size and fixed server fields", async () => {
  const f = await setupReview()
  const previous = process.env.APP_ORIGIN
  const origin = "https://facts.invalid"
  process.env.APP_ORIGIN = origin
  let viewer = false
  try {
    const services = async () => ({ identity: async () => testIdentity, authorize: async (identity: typeof testIdentity, id: string, action: "read" | "edit" | "manage") => ({ identity, projectId: id, action, role: viewer ? "viewer" as const : "editor" as const }), service: service(f) })
    const invoke = (operation: "list" | "save" | "history", input?: unknown, requestOrigin = origin) => factsHandler(services, operation)(new NextRequest(`${origin}/api/projects/${projectId}/facts`, { method: operation === "save" ? "POST" : "GET", headers: { origin: requestOrigin, "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }), { params: Promise.resolve({ id: projectId, factId: "missing" }) })
    assert.equal((await invoke("save", request(f))).status, 200)
    assert.equal((await invoke("history")).status, 404)
    assert.equal((await invoke("save", request(f), "https://foreign.invalid")).status, 403)
    assert.equal((await invoke("save", { ...request(f), value: { ...draft(f), createdBy: "forged" } })).status, 400)
    assert.equal((await invoke("save", { ...request(f), reason: "x".repeat(262144) })).status, 429)
    viewer = true
    const read = await invoke("list")
    assert.equal(read.status, 200)
    assert.equal(read.headers.get("cache-control"), "private, no-store")
    assert.equal((await invoke("save", { ...request(f), operationId: "viewer" })).status, 403)
  } finally { if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous; await f.close() }
})

async function executionSetup() {
  const f = await setupReview()
  await f.tasks.submit(accountId, "facts-task", { kind: "document-analysis", projectId, refs: { materials: [{ materialVersionId: f.materials[0].versionId, sha256: f.materials[0].sha256 }] }, conditions: { externalProcessingConsent: true } })
  const job = await f.tasks.claimNext()
  assert.ok(job)
  const results = new ResultService(new ResultRepository(f.database), new ResultValidatorRegistry(new Map([["fact-candidates", factCandidatesValidator]])))
  const candidate = { field: "支付方式", nature: "材料记载", originalValue: "按月计量", sources: [{ snapshotId: f.materials[0].snapshotId, fragmentId: "fragment-1-0", quote: "合同价款按月度计量支付。" }] }
  const deps: FactsExecutorDependencies = { repository: f.repository, store: f.store, readProjectRetention: async () => f.projectRetention, results,
    identityFor: () => testIdentity, authorize: async ({ projectId, action }) => ({ projectId, action, role: "editor", account: testIdentity.account }),
    extractor: async input => { await input.onBeforeCall(1); await input.onExchange(1); return { candidates: [candidate] } } }
  return { f, job, deps, candidate, results }
}

test("AC-06/19/23: facts executor persists real machine provenance and rejects invalid candidates as partial", async () => {
  const { f, job, deps, candidate, results } = await executionSetup()
  try {
    const calls: number[] = []
    const outcome = await createFactsExecutor({ ...deps, extractor: async input => { await input.onBeforeCall(1); await input.onExchange(1); return { candidates: [candidate, { ...candidate, sources: [{ ...candidate.sources[0], quote: "不存在" }] }] } } })(job, executorContext({ reserveCall: async call => { calls.push(call) } }))
    assert.equal(outcome.outcome, "partial"); assert.deepEqual(calls, [1])
    const [saved] = await results.list(testIdentity, testAuthorizer, projectId)
    assert.equal(saved.origin, "machine"); assert.equal(saved.provenance?.taskId, job.id)
    assert.equal((saved.value as FactCandidatesValue).candidates.length, 1)
    assert.equal((saved.value as FactCandidatesValue).rejected.length, 1)
    assert.equal((await new FactRepository(f.database).listLatest(projectId)).length, 0)
  } finally { await f.close() }
})

test("AC-23/24: facts executor refuses all-invalid, revoked, exhausted and stale-attempt writes", async () => {
  for (const mode of ["all-invalid", "revoked", "budget", "stale"] as const) {
    const { f, job, deps, results } = await executionSetup()
    try {
      if (mode === "stale") await f.database.transaction(c => c.query("UPDATE equilens_tasks SET execution_token=$1 WHERE id=$2", ["new-token", job.id]))
      const run = createFactsExecutor({ ...deps, ...(mode === "all-invalid" ? { extractor: async () => ({ candidates: [{ field: "missing source" }] }) } : {}) })(mode === "budget" ? { ...job, callsUsed: job.maxCalls } : job,
        executorContext(mode === "revoked" ? { refreshAccess: async () => { throw Object.assign(new Error("revoked"), { code: "ACCESS_REVOKED" }) } } : {}))
      if (mode === "revoked") await assert.rejects(run, { code: "ACCESS_REVOKED" })
      else assert.equal((await run).outcome, "failed", mode)
      assert.equal((await results.list(testIdentity, testAuthorizer, projectId)).length, 0)
    } finally { await f.close() }
  }
})

test("fact-candidates validator rejects foreign snapshots and malformed vocabularies", async () => {
  const { f, deps, job, results } = await executionSetup()
  try {
    assert.equal((await createFactsExecutor(deps)(job, executorContext())).outcome, "success")
    const value = (await results.list(testIdentity, testAuthorizer, projectId))[0].value as FactCandidatesValue
    assert.equal((await factCandidatesValidator(value)).status, "valid")
    assert.equal((await factCandidatesValidator({ ...value, candidates: [{ ...value.candidates[0], nature: "法院认定" }] })).status, "invalid")
    assert.equal((await factCandidatesValidator({ ...value, materials: [{ ...value.materials[0], snapshotId: "foreign" }] })).status, "invalid")
    assert.equal((await factCandidatesValidator({ ...value, complete: false })).status, "partial")
  } finally { await f.close() }
})

test("facts extractor retries malformed JSON within its cap and never bypasses reservation", async () => {
  let requests = 0; const reservations: number[] = []; const bodies: Array<Record<string, unknown>> = []
  const extractor = createFactExtractor(async (_request, init) => { requests++; bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ choices: [{ finish_reason: "stop", message: { content: requests === 1 ? "invalid" : '{"candidates":[]}' } }] }) })
  const input = { complete: true, materials: [], paragraphs: [{ snapshotId: "s", fragmentId: "f", text: "原文" }], maxCalls: 2, signal: new AbortController().signal,
    env: { AI_API_KEY: "test", AI_BASE_URL: "https://model.invalid/v1" }, onBeforeCall: async (call: number) => { reservations.push(call) }, onExchange: async () => {} }
  assert.deepEqual(await extractor(input), { candidates: [] }); assert.deepEqual(reservations, [1, 2])
  // Reasoning tokens count against max_tokens: the cap must leave room for the JSON body.
  assert.equal(bodies[0].max_tokens, 8192); assert.deepEqual(bodies[0].response_format, { type: "json_object" })
  await assert.rejects(extractor({ ...input, onBeforeCall: async () => { throw new BusinessError("BUDGET_EXHAUSTED", "预算已用尽。") } }), { code: "BUDGET_EXHAUSTED" })
  assert.equal(requests, 2)
})
