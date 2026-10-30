import assert from "node:assert/strict"
import { test } from "node:test"
import {
  domainReviewer, publishableContent, publishedFixturePack, publishVersion, scene, setupKnowledge,
  submitDraft,
} from "./test-fixtures"
import { KnowledgeError } from "./errors"
import { loadPublishedRulePack, resolvePublicationBasis } from "./resolver"
import {
  clearPublicationResolver, publicationResolverRegistered, registerPublicationResolver, resolvePublication,
} from "../tasks/publications"
import { knowledgeRuntimeStarted, registerKnowledgePublicationRuntime } from "./registration"
const expectResolution = async (
  fixture: Awaited<ReturnType<typeof setupKnowledge>>,
  state: "pinned" | "none" | "blocked",
  conditions: Record<string, unknown> = { scene: "auto", role: "专业分包人", region: "上海", externalProcessingConsent: true },
) => {
  const resolution = await resolvePublicationBasis(fixture.repository, {
    kind: "contract-review", projectId: "project-1", refs: { materials: [] }, conditions,
  })
  assert.equal(resolution.state, state)
  return resolution
}

test("C6 lifecycle: the resolver registration seam registers once without running the provider", () => {
  clearPublicationResolver()
  assert.equal(publicationResolverRegistered(), false)
  assert.equal(knowledgeRuntimeStarted(), false)
  const provider = async (): Promise<never> => { throw new Error("provider must not run during registration") }
  registerKnowledgePublicationRuntime(provider)
  assert.equal(knowledgeRuntimeStarted(), true)
  assert.equal(publicationResolverRegistered(), true)
  registerKnowledgePublicationRuntime(provider)
  assert.equal(publicationResolverRegistered(), true)
  clearPublicationResolver()
})

test("C6 resolver: a scene without publication history keeps the debug path (none)", async () => {
  const fixture = await setupKnowledge()
  try {
    const resolution = await expectResolution(fixture, "none")
    assert.deepEqual(resolution, { state: "none" })
  } finally { await fixture.close() }
})

test("C6 resolver: a published rule pack is pinned with its immutable refs (auto resolves the default scene)", async () => {
  const fixture = await setupKnowledge()
  try {
    const published = await publishedFixturePack(fixture)
    const resolution = await expectResolution(fixture, "pinned")
    assert.equal(resolution.state, "pinned")
    if (resolution.state !== "pinned") return
    assert.deepEqual(resolution.pin.rules, [{ id: published.publicationId, versionId: published.versionId, sha256: published.sha256 }])
    assert.deepEqual(resolution.pin.knowledge, [])
    assert.deepEqual(resolution.pin.templates, [])
  } finally { await fixture.close() }
})

test("C6 resolver: draft, pending, disabled and superseded-pending states block new submissions", async () => {
  const draftFixture = await setupKnowledge()
  try {
    await submitDraft(draftFixture, { content: publishableContent() })
    const resolution = await expectResolution(draftFixture, "blocked")
    assert.equal(resolution.state, "blocked")
    if (resolution.state === "blocked") assert.match(resolution.reason, /草稿/)
  } finally { await draftFixture.close() }

  const pendingFixture = await setupKnowledge()
  try {
    await submitDraft(pendingFixture, { reviewer: domainReviewer, content: publishableContent() })
    const resolution = await expectResolution(pendingFixture, "blocked")
    if (resolution.state === "blocked") assert.match(resolution.reason, /待核对/)
  } finally { await pendingFixture.close() }

  const disabledFixture = await setupKnowledge()
  try {
    const published = await publishedFixturePack(disabledFixture)
    await disabledFixture.service.disable({
      versionId: published.versionId, operatorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", reason: "合成测试停用",
    })
    const resolution = await expectResolution(disabledFixture, "blocked")
    if (resolution.state === "blocked") assert.match(resolution.reason, /已停用/)
  } finally { await disabledFixture.close() }

  // A pending replacement blocks new submissions even while the previous
  // version is still published: fail-closed, never a silent debug downgrade.
  const replacementFixture = await setupKnowledge()
  try {
    await publishedFixturePack(replacementFixture)
    await submitDraft(replacementFixture, { reviewer: secondReviewerForFixture(), content: publishableContent({ extraRule: true }) })
    await expectResolution(replacementFixture, "blocked")
  } finally { await replacementFixture.close() }
})

function secondReviewerForFixture(): string { return "domain-reviewer-2" }

test("C6 resolver: a correction pins only the newest published version", async () => {
  const fixture = await setupKnowledge()
  try {
    const first = await publishedFixturePack(fixture)
    const second = await submitDraft(fixture, { content: publishableContent({ extraRule: true }) })
    const latest = await publishVersion(fixture, second)
    const resolution = await expectResolution(fixture, "pinned")
    if (resolution.state !== "pinned") return
    assert.equal(resolution.pin.rules[0].versionId, latest.versionId)
    assert.notEqual(resolution.pin.rules[0].versionId, first.versionId)
  } finally { await fixture.close() }
})

test("C6 resolver: multiple published rule packs for one scene are ambiguous and blocked", async () => {
  const fixture = await setupKnowledge()
  try {
    await publishedFixturePack(fixture)
    await publishedFixturePack(fixture, { artifactId: "synthetic-contract-review-second" })
    const resolution = await expectResolution(fixture, "blocked")
    if (resolution.state === "blocked") assert.match(resolution.reason, /不唯一/)
  } finally { await fixture.close() }
})

test("C6 resolver: publication history for another scene or task kind does not affect contract review", async () => {
  const fixture = await setupKnowledge()
  try {
    await publishedFixturePack(fixture, { scene: "decoration-sub-2026", artifactId: "synthetic-decoration-pack" })
    // mep-sub-2026 has no history at all -> none.
    await expectResolution(fixture, "none", { scene: "mep-sub-2026", role: "专业分包人", region: "上海" })
    // decoration-sub-2026 is pinned for that explicit scene.
    await expectResolution(fixture, "pinned", { scene: "decoration-sub-2026", role: "专业分包人", region: "上海" })
    // Other task kinds have no published-basis contract yet.
    const resolution = await resolvePublicationBasis(fixture.repository, {
      kind: "bid-verification", projectId: "project-1", refs: {}, conditions: { scene: "decoration-sub-2026" },
    })
    assert.deepEqual(resolution, { state: "none" })
  } finally { await fixture.close() }
})

test("C6 resolver: tampered stored content fails closed instead of pinning or downgrading", async () => {
  const fixture = await setupKnowledge()
  try {
    const published = await publishedFixturePack(fixture)
    const stored = (await fixture.database.transaction(connection =>
      connection.query("SELECT * FROM equilens_publication_versions WHERE id=$1", [published.versionId]))).rows[0]
    const payload = JSON.parse(String(stored.payload_json)) as Record<string, unknown>
    payload.manifest = { ...(payload.manifest as Record<string, unknown>), name: "被篡改的规则包" }
    await fixture.database.transaction(connection =>
      connection.query("UPDATE equilens_publication_versions SET payload_json=$1 WHERE id=$2", [JSON.stringify(payload), published.versionId]))
    await assert.rejects(
      resolvePublicationBasis(fixture.repository, { kind: "contract-review", projectId: "project-1", refs: {}, conditions: { scene } }),
      (failure: unknown) => failure instanceof KnowledgeError && failure.code === "SERVICE_UNAVAILABLE",
    )
    // Through the task-submission seam the failure is a hard 503, never debug.
    clearPublicationResolver()
    registerPublicationResolver(async () => resolvePublicationBasis(fixture.repository, {
      kind: "contract-review", projectId: "project-1", refs: {}, conditions: { scene },
    }))
    await assert.rejects(
      resolvePublication({ kind: "contract-review", projectId: "project-1", refs: {}, conditions: { scene } }),
      (failure: unknown) => (failure as { status?: number }).status === 503,
    )
    clearPublicationResolver()
  } finally { await fixture.close() }
})

test("C6 seam: submission without a registered resolver is 503 and never a debug fallback", async () => {
  clearPublicationResolver()
  await assert.rejects(
    resolvePublication({ kind: "contract-review", projectId: "project-1", refs: {}, conditions: { scene } }),
    (failure: unknown) => (failure as { status?: number }).status === 503 && (failure as { code?: string }).code === "SERVICE_UNAVAILABLE",
  )
})

test("C6 seam: registered resolver output is validated and returns a pinned basis through resolvePublication", async () => {
  const fixture = await setupKnowledge()
  try {
    await publishedFixturePack(fixture)
    clearPublicationResolver()
    registerPublicationResolver(async () => resolvePublicationBasis(fixture.repository, {
      kind: "contract-review", projectId: "project-1", refs: {}, conditions: { scene },
    }))
    const resolution = await resolvePublication({ kind: "contract-review", projectId: "project-1", refs: {}, conditions: { scene } })
    assert.equal(resolution.state, "pinned")
    if (resolution.state === "pinned") assert.equal(resolution.pin.rules.length, 1)
    clearPublicationResolver()
  } finally { await fixture.close() }
})

test("C6 pinned-pack loader: loads the immutable DB pack and flags a disabled basis as retired", async () => {
  const fixture = await setupKnowledge()
  try {
    const published = await publishedFixturePack(fixture)
    const ref = { id: published.publicationId, versionId: published.versionId, sha256: published.sha256 }
    const loaded = await loadPublishedRulePack(fixture.repository, ref)
    assert.equal(loaded.pack.manifest.status, "已发布")
    assert.equal(loaded.pack.rules.length, 1)
    assert.equal(loaded.pack.rules[0].status, "已发布")
    assert.equal(loaded.scene, scene)
    assert.equal(loaded.disabled, false)
    assert.equal(loaded.versionId, published.versionId)

    await fixture.service.disable({
      versionId: published.versionId, operatorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", reason: "合成测试停用",
    })
    const retired = await loadPublishedRulePack(fixture.repository, ref)
    assert.equal(retired.disabled, true)
    assert.equal(retired.pack.rules[0].status, "已发布")
  } finally { await fixture.close() }
})

test("C6 pinned-pack loader: wrong refs, draft versions and tampered content are rejected", async () => {
  const fixture = await setupKnowledge()
  try {
    const published = await publishedFixturePack(fixture)
    const ref = { id: published.publicationId, versionId: published.versionId, sha256: published.sha256 }
    await assert.rejects(loadPublishedRulePack(fixture.repository, { ...ref, sha256: "0".repeat(64) }),
      (failure: unknown) => failure instanceof KnowledgeError && failure.code === "INVALID_CONTENT")
    await assert.rejects(loadPublishedRulePack(fixture.repository, { ...ref, id: "another-publication" }),
      (failure: unknown) => failure instanceof KnowledgeError && failure.code === "INVALID_CONTENT")
    const draft = await submitDraft(fixture, { content: publishableContent({ extraRule: true }) })
    await assert.rejects(loadPublishedRulePack(fixture.repository, { id: draft.publicationId, versionId: draft.versionId, sha256: draft.sha256 }),
      (failure: unknown) => failure instanceof KnowledgeError && failure.code === "INVALID_CONTENT")
    const stored = (await fixture.database.transaction(connection =>
      connection.query("SELECT * FROM equilens_publication_versions WHERE id=$1", [published.versionId]))).rows[0]
    await fixture.database.transaction(connection =>
      connection.query("UPDATE equilens_publication_versions SET sources_json=$1 WHERE id=$2", [JSON.stringify([]), published.versionId]))
    await assert.rejects(loadPublishedRulePack(fixture.repository, ref),
      (failure: unknown) => failure instanceof KnowledgeError && failure.code === "SERVICE_UNAVAILABLE")
    assert.ok(String(stored.sources_json).includes("SYN-SRC-1"))
  } finally { await fixture.close() }
})
