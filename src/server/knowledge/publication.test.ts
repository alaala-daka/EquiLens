import assert from "node:assert/strict"
import { test } from "node:test"
import { KnowledgeError } from "./errors"
import {
  artifactId, disabledOperatorId, domainReviewer, fixedVerifiedAt, memberAccountId, operatorAccountId,
  operatorUsername, publishableContent, publishedFixturePack, publishVersion, reviewerEnv, scene, secondReviewer,
  setupKnowledge, submitDraft, syntheticContent,
} from "./test-fixtures"

const expectCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (failure: unknown) => failure instanceof KnowledgeError && failure.code === code)

async function row(fixture: Awaited<ReturnType<typeof setupKnowledge>>, versionId: string) {
  return (await fixture.database.transaction(connection =>
    connection.query("SELECT * FROM equilens_publication_versions WHERE id=$1", [versionId]))).rows[0]
}

test("C6 state machine: draft and pending versions may have null reviewer/verified_at/review_evidence", async () => {
  const fixture = await setupKnowledge()
  try {
    const draft = await submitDraft(fixture)
    assert.equal(draft.state, "draft")
    assert.equal(draft.version, "1")
    assert.equal(draft.reviewer, null)
    assert.equal(draft.verifiedAt, null)
    assert.equal(draft.reviewEvidence, null)
    assert.equal(draft.publishedAt, null)
    assert.equal(draft.content.ruleCount, 1)
    const stored = await row(fixture, draft.versionId)
    assert.equal(stored.state, "draft")
    assert.equal(stored.reviewer, null)
    assert.equal(stored.verified_at, null)
    assert.equal(stored.review_evidence, null)

    const pending = await submitDraft(fixture, { reviewer: domainReviewer })
    assert.equal(pending.state, "pending_verification")
    assert.equal(pending.version, "2")
    assert.equal(pending.reviewer, domainReviewer)
    assert.equal(pending.verifiedAt, null)
    assert.equal(pending.reviewEvidence, null)
    const storedPending = await row(fixture, pending.versionId)
    assert.equal(storedPending.state, "pending_verification")
    assert.equal(storedPending.reviewer, domainReviewer)
    assert.equal(storedPending.verified_at, null)
  } finally { await fixture.close() }
})

test("C6 state machine: publish requires reviewer, time, evidence and expected sha without changing state", async () => {
  const fixture = await setupKnowledge()
  try {
    const pending = await submitDraft(fixture, { reviewer: domainReviewer, content: publishableContent() })
    const unchanged = async () => {
      const stored = await row(fixture, pending.versionId)
      assert.equal(stored.state, "pending_verification")
      assert.equal(stored.verified_at, null)
      assert.equal(stored.review_evidence, null)
      assert.equal(stored.published_at, null)
    }
    // Missing / unlisted reviewer.
    await expectCode(publishVersion(fixture, pending, { reviewer: "stranger" }), "FORBIDDEN")
    await unchanged()
    // Invalid verification time.
    await expectCode(publishVersion(fixture, pending, { verifiedAt: "" }), "INVALID_INPUT")
    await expectCode(publishVersion(fixture, pending, { verifiedAt: "2026-10-29" }), "INVALID_INPUT")
    await expectCode(publishVersion(fixture, pending, { verifiedAt: "2020-01-01T00:00:00.000Z" }), "INVALID_INPUT")
    await unchanged()
    // Missing review evidence.
    await expectCode(publishVersion(fixture, pending, { reviewEvidence: "   " }), "INVALID_INPUT")
    await unchanged()
    // Expected sha mismatch (digest tamper guard).
    await expectCode(publishVersion(fixture, pending, { expectedSha256: "0".repeat(64) }), "INVALID_CONTENT")
    await unchanged()
    // A draft (no reviewer registered) can still be published with all guards.
    const draft = await submitDraft(fixture, { content: publishableContent() })
    const published = await publishVersion(fixture, draft)
    assert.equal(published.state, "published")
    assert.equal(published.reviewer, domainReviewer)
    assert.equal(published.verifiedAt, fixedVerifiedAt)
    assert.equal(published.reviewEvidence, "合成测试核对证据：仅验证发布机制，非真实领域核对。")
  } finally { await fixture.close() }
})

test("C6 fake-signoff guard: operator must be an existing enabled superadmin and reviewer must be allowed", async () => {
  const fixture = await setupKnowledge()
  try {
    const draft = await submitDraft(fixture, { content: publishableContent() })
    await expectCode(fixture.service.submit({
      kind: "rules", artifactId, scene, content: publishableContent(), operatorId: memberAccountId,
    }), "FORBIDDEN")
    await expectCode(fixture.service.submit({
      kind: "rules", artifactId, scene, content: publishableContent(), operatorId: disabledOperatorId,
    }), "FORBIDDEN")
    await expectCode(fixture.service.submit({
      kind: "rules", artifactId, scene, content: publishableContent(), operatorId: "99999999-9999-4999-8999-999999999999",
    }), "FORBIDDEN")
    await expectCode(publishVersion(fixture, draft, { operatorId: memberAccountId }), "FORBIDDEN")
    await expectCode(publishVersion(fixture, draft, { operatorId: disabledOperatorId }), "FORBIDDEN")
    // The uploader's account is re-read: disabling it refuses further maintenance.
    await fixture.database.transaction(connection =>
      connection.query("UPDATE equilens_auth_accounts SET enabled=0 WHERE id=$1", [operatorAccountId]))
    await expectCode(publishVersion(fixture, draft), "FORBIDDEN")
    assert.equal((await row(fixture, draft.versionId)).state, "draft")
  } finally { await fixture.close() }
})

test("C6 fake-signoff guard: reviewer may not equal the operator and a pending reviewer cannot be swapped", async () => {
  const ownReviewerFixture = await setupKnowledge({ env: { EQUILENS_DOMAIN_REVIEWERS: `${operatorUsername},${operatorAccountId}` } })
  try {
    const draft = await submitDraft(ownReviewerFixture, { content: publishableContent() })
    await expectCode(publishVersion(ownReviewerFixture, draft, { reviewer: operatorUsername }), "FORBIDDEN")
    await expectCode(publishVersion(ownReviewerFixture, draft, { reviewer: operatorAccountId }), "FORBIDDEN")
    assert.equal((await row(ownReviewerFixture, draft.versionId)).state, "draft")
  } finally { await ownReviewerFixture.close() }

  const fixture = await setupKnowledge()
  try {
    const pending = await submitDraft(fixture, { reviewer: domainReviewer, content: publishableContent() })
    await expectCode(publishVersion(fixture, pending, { reviewer: secondReviewer }), "CONFLICT")
    assert.equal((await row(fixture, pending.versionId)).state, "pending_verification")
  } finally { await fixture.close() }
})

test("C6 published transition: only published sources/rules can form a published pack", async () => {
  const fixture = await setupKnowledge()
  try {
    const unpublishedSource = await submitDraft(fixture, {
      content: syntheticContent({ status: "已发布", ruleStatus: "已发布", sourceStatus: "待核对" }),
    })
    await expectCode(publishVersion(fixture, unpublishedSource), "INVALID_CONTENT")
    assert.equal((await row(fixture, unpublishedSource.versionId)).state, "draft")
    const unpublishedRule = await submitDraft(fixture, {
      content: syntheticContent({ status: "待核对", ruleStatus: "待核对", sourceStatus: "已发布" }),
    })
    await expectCode(publishVersion(fixture, unpublishedRule), "INVALID_CONTENT")
    assert.equal((await row(fixture, unpublishedRule.versionId)).state, "draft")
  } finally { await fixture.close() }
})

test("C6 digest tamper: a payload changed after submission cannot be published", async () => {
  const fixture = await setupKnowledge()
  try {
    const draft = await submitDraft(fixture, { content: publishableContent() })
    const stored = await row(fixture, draft.versionId)
    const payload = JSON.parse(String(stored.payload_json)) as Record<string, unknown>
    const manifest = payload.manifest as Record<string, unknown>
    payload.manifest = { ...manifest, name: "被篡改的合成规则包" }
    await fixture.database.transaction(connection =>
      connection.query("UPDATE equilens_publication_versions SET payload_json=$1 WHERE id=$2", [JSON.stringify(payload), draft.versionId]))
    await expectCode(publishVersion(fixture, draft), "INVALID_CONTENT")
    const unchanged = await row(fixture, draft.versionId)
    assert.equal(unchanged.state, "draft")
    assert.equal(unchanged.sha256, draft.sha256)
  } finally { await fixture.close() }
})

test("C6 immutability: a published version cannot be republished or edited; history survives disable", async () => {
  const fixture = await setupKnowledge()
  try {
    const draft = await submitDraft(fixture, { content: publishableContent() })
    const before = await row(fixture, draft.versionId)
    const published = await publishVersion(fixture, draft)
    assert.equal(published.state, "published")
    assert.ok(published.publishedAt)
    const after = await row(fixture, draft.versionId)
    // Content columns are untouched by the lifecycle transition.
    assert.equal(after.payload_json, before.payload_json)
    assert.equal(after.sources_json, before.sources_json)
    assert.equal(after.sha256, before.sha256)
    assert.equal(after.created_by, before.created_by)
    await expectCode(publishVersion(fixture, published), "INVALID_STATE")

    const disabled = await fixture.service.disable({
      versionId: published.versionId, operatorId: operatorAccountId, reason: "合成测试：依据被人工停用",
    })
    assert.equal(disabled.state, "disabled")
    assert.ok(disabled.disabledAt)
    assert.equal(disabled.disabledReason, "合成测试：依据被人工停用")
    const afterDisable = await row(fixture, published.versionId)
    assert.equal(afterDisable.payload_json, before.payload_json)
    await expectCode(fixture.service.disable({
      versionId: published.versionId, operatorId: operatorAccountId, reason: "重复停用",
    }), "INVALID_STATE")
    await expectCode(publishVersion(fixture, published), "INVALID_STATE")
    // Disabled history stays readable through the private maintenance views.
    assert.equal((await fixture.service.showVersion(published.versionId)).state, "disabled")
  } finally { await fixture.close() }
})

test("C6 supersede: a correction publishes a new version and conditionally disables the old published version", async () => {
  const fixture = await setupKnowledge()
  try {
    const first = await publishedFixturePack(fixture)
    assert.equal(first.version, "1")
    const second = await submitDraft(fixture, { content: publishableContent({ extraRule: true }) })
    assert.equal(second.version, "2")
    const latest = await publishVersion(fixture, second)
    assert.equal(latest.state, "published")
    assert.equal(latest.supersedesId, first.versionId)
    const old = await fixture.service.showVersion(first.versionId)
    assert.equal(old.state, "disabled")
    assert.equal(old.disabledReason, "已被发布版本 2 替代")
    assert.ok(old.publishedAt)
    // Both immutable versions remain readable; only one is currently published.
    const summaries = await fixture.service.list({ kind: "rules", artifactId })
    assert.equal(summaries.length, 1)
    assert.deepEqual(summaries[0].versions.map(version => version.state), ["disabled", "published"])
    assert.equal(summaries[0].latestVersion?.versionId, latest.versionId)
  } finally { await fixture.close() }
})

test("C6 content guard: file/path-shaped content and identifiers are rejected and no path is stored", async () => {
  const fixture = await setupKnowledge()
  try {
    await expectCode(fixture.service.submit({
      kind: "rules", artifactId: "../escape", scene, content: publishableContent(), operatorId: operatorAccountId,
    }), "INVALID_INPUT")
    await expectCode(fixture.service.submit({
      kind: "rules", artifactId, scene: "unknown-scene", content: publishableContent(), operatorId: operatorAccountId,
    }), "INVALID_INPUT")
    await expectCode(submitDraft(fixture, {
      content: JSON.stringify({ ...JSON.parse(publishableContent()), ruleFiles: ["rules/a.json"] }),
    }), "INVALID_CONTENT")
    const pathInDescription = JSON.parse(publishableContent()) as { manifest: Record<string, unknown> }
    pathInDescription.manifest.description = "本地文件：C:\\secret\\rules\\pack.json"
    await expectCode(submitDraft(fixture, { content: JSON.stringify(pathInDescription) }), "INVALID_CONTENT")
    const traversalText = JSON.parse(publishableContent()) as { sources: Array<Record<string, unknown>> }
    traversalText.sources[0].name = "../../outside/source.json"
    await expectCode(submitDraft(fixture, { content: JSON.stringify(traversalText) }), "INVALID_CONTENT")
    const unknownKey = { ...JSON.parse(publishableContent()), sourceFiles: ["sources.json"] }
    await expectCode(submitDraft(fixture, { content: JSON.stringify(unknownKey) }), "INVALID_CONTENT")
    assert.equal((await fixture.service.list({ kind: "rules", artifactId })).length, 0)

    const draft = await submitDraft(fixture, { content: publishableContent() })
    const stored = await row(fixture, draft.versionId)
    for (const column of ["payload_json", "sources_json", "applicability_json"]) {
      assert.ok(!String(stored[column]).includes("\\\\"), `${column} must not store Windows paths`)
      assert.ok(!String(stored[column]).includes("../"), `${column} must not store traversal paths`)
    }
  } finally { await fixture.close() }
})

test("C6 content guard: applicability must match the declared scene and role", async () => {
  const fixture = await setupKnowledge()
  try {
    const wrongScene = JSON.parse(publishableContent()) as { rules: Array<Record<string, unknown>> }
    wrongScene.rules[0].appliesTo = { scene: "decoration-sub-2026", role: "专业分包人" }
    await expectCode(submitDraft(fixture, { content: JSON.stringify(wrongScene) }), "INVALID_CONTENT")
    const wrongRole = JSON.parse(publishableContent()) as { rules: Array<Record<string, unknown>> }
    wrongRole.rules[0].appliesTo = { scene, role: "承包人" }
    await expectCode(submitDraft(fixture, { content: JSON.stringify(wrongRole) }), "INVALID_CONTENT")
  } finally { await fixture.close() }
})

test("C6 reads are artifact-scoped: a kind/artifact lookup never returns another artifact's version", async () => {
  const fixture = await setupKnowledge()
  try {
    const published = await publishedFixturePack(fixture)
    assert.equal(await fixture.repository.findPublication("knowledge", artifactId), null)
    assert.equal(await fixture.repository.findPublication("rules", "another-artifact"), null)
    assert.equal((await fixture.repository.versionsForPublication(published.publicationId)).length, 1)
    assert.equal((await fixture.repository.versionsForScene(scene)).length, 1)
    assert.equal((await fixture.repository.versionsForScene("decoration-sub-2026")).length, 0)
    await expectCode(fixture.service.showLatest("knowledge", artifactId), "NOT_FOUND")
    await expectCode(fixture.service.showVersion("../../etc/passwd"), "NOT_FOUND")
  } finally { await fixture.close() }
})

test("C6 unpublished content remains submit-only: validate reports blockers without any write", async () => {
  const fixture = await setupKnowledge()
  try {
    const checked = fixture.service.validate("rules", scene, syntheticContent())
    assert.equal(checked.publishable, false)
    assert.ok(checked.publishBlockers.length > 0)
    assert.equal(checked.ruleCount, 1)
    assert.equal(checked.sourceCount, 1)
    assert.equal(JSON.stringify(checked).includes("合成测试要求"), false, "validate output must not echo rule text")
    const publishedContent = fixture.service.validate("rules", scene, publishableContent())
    assert.equal(publishedContent.publishable, true)
    assert.equal(publishedContent.sha256.length, 64)
    // The content digest is deterministic and differs from the unpublished draft digest.
    const repeated = fixture.service.validate("rules", scene, publishableContent())
    assert.equal(repeated.sha256, publishedContent.sha256)
    assert.notEqual(publishedContent.sha256, checked.sha256)
    // Read-only validate creates no publication row.
    assert.equal((await fixture.service.list()).length, 0)
  } finally { await fixture.close() }
})

test("C6 list/show redaction: metadata and counts only, never stored content text", async () => {
  const fixture = await setupKnowledge()
  try {
    await publishedFixturePack(fixture)
    const listText = JSON.stringify(await fixture.service.list())
    assert.equal(listText.includes("合成测试要求"), false)
    assert.equal(listText.includes("合成测试来源正文"), false)
    const showText = JSON.stringify(await fixture.service.showVersion((await fixture.service.list())[0].latestVersion!.versionId))
    assert.equal(showText.includes("合成测试要求"), false)
    assert.equal(showText.includes("合成测试来源正文"), false)
    assert.ok(showText.includes("合成测试规则包"))
  } finally { await fixture.close() }
})

test("C6 reviewer allowlist: empty deployment configuration refuses every publish", async () => {
  const fixture = await setupKnowledge({ env: {} })
  try {
    const draft = await submitDraft(fixture, { content: publishableContent() })
    await expectCode(publishVersion(fixture, draft), "FORBIDDEN")
    assert.equal((await row(fixture, draft.versionId)).state, "draft")
  } finally { await fixture.close() }
})

test("C6 operations are re-read per call: a stale operator snapshot cannot publish", async () => {
  const fixture = await setupKnowledge()
  try {
    const draft = await submitDraft(fixture, { content: publishableContent() })
    await fixture.database.transaction(connection =>
      connection.query("UPDATE equilens_auth_accounts SET role='member' WHERE id=$1", [operatorAccountId]))
    await expectCode(publishVersion(fixture, draft), "FORBIDDEN")
    assert.equal((await row(fixture, draft.versionId)).state, "draft")
  } finally { await fixture.close() }
})

test("C6 reviewer environment parsing trims and ignores malformed allowlist entries", async () => {
  const fixture = await setupKnowledge({ env: { EQUILENS_DOMAIN_REVIEWERS: ` ${domainReviewer} , ,bad reviewer` } })
  try {
    const draft = await submitDraft(fixture, { content: publishableContent() })
    const published = await publishVersion(fixture, draft, { reviewer: ` ${domainReviewer} ` })
    assert.equal(published.state, "published")
    assert.equal(published.reviewer, domainReviewer)
    assert.ok(!reviewerEnv.EQUILENS_DOMAIN_REVIEWERS?.includes("bad reviewer"))
  } finally { await fixture.close() }
})
