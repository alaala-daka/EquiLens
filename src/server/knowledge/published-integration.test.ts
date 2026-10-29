import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import type { AgentReviewOptions } from "../../../tools/contract-review/src/agent"
import type { ReviewSkill } from "../../../tools/contract-review/src/agent/skill"
import type { SceneBundle } from "../../../tools/contract-review/src/bundles"
import { sceneCatalog, type SceneCandidate } from "../../../tools/contract-review/src/scenes"
import type { ReviewResult } from "../../../tools/contract-review/src/types"
import type { PublicationPin } from "../tasks/publications"
import { buildTaskManifest, parseTaskRequest, type TaskRequest } from "../tasks/catalog"
import { AuthService } from "../auth/service"
import { createProjectReviewExecutor, type ProjectReviewRunner, type ProjectReviewRunnerInput, type PublishedReviewResult } from "../reviews/executor"
import { createProjectReviewRunner, RETIRED_BASIS_WARNING } from "../reviews/runner"
import { executorContext, executorDependencies, projectId, setupReview, successResult, testAuthorizer, testIdentity } from "../reviews/test-fixtures"
import { loadPublishedRulePack, resolvePublicationBasis } from "./resolver"
import { KnowledgeRepository } from "./repository"
import { PublicationService } from "./publication"
import { statements as knowledgeStatements } from "./schema"
import {
  domainReviewer, fixedNow, operatorAccountId, operatorUsername, publishableContent, reviewerEnv,
} from "./test-fixtures"

/**
 * C6 end-to-end mechanism test: a pinned published rule pack flows from the
 * task manifest through the production review runner (DB pack, published mode)
 * into a saved machine result, and a version disabled after submission still
 * executes its immutable content with the "依据已停用" warning.
 *
 * All rule content is a synthetic fixture (see test-fixtures.ts); it is never
 * inserted into an application database outside these in-memory tests.
 */
const sha = (value: string) => createHash("sha256").update(value).digest("hex")

async function ensureKnowledgeSchema(database: Awaited<ReturnType<typeof setupReview>>["database"]): Promise<void> {
  const applied = await database.transaction(connection =>
    connection.query("SELECT id FROM equilens_business_migrations WHERE id='0011'"))
  if (applied.rows.length) return
  await database.transaction(async connection => {
    for (const statement of knowledgeStatements) await connection.query(statement)
  })
}

async function knowledgeService(fixture: Awaited<ReturnType<typeof setupReview>>): Promise<{ repository: KnowledgeRepository; service: PublicationService }> {
  await ensureKnowledgeSchema(fixture.database)
  await fixture.database.transaction(async connection => {
    await connection.query(
      "INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision,role) VALUES($1,$2,$3,$4,$5,$6)",
      [operatorAccountId, operatorUsername, "x", 1, 1, "superadmin"],
    )
  })
  let counter = 0
  const repository = new KnowledgeRepository(fixture.database, {
    now: () => new Date(fixedNow),
    id: () => "10000000-0000-4000-8000-" + String(++counter).padStart(12, "0"),
  })
  const service = new PublicationService({
    repository, auth: new AuthService(fixture.database), env: reviewerEnv, now: () => new Date(fixedNow),
  })
  return { repository, service }
}

async function publishedPin(repository: KnowledgeRepository): Promise<PublicationPin> {
  const resolution = await resolvePublicationBasis(repository, {
    kind: "contract-review", projectId, refs: {}, conditions: { scene: "auto" },
  })
  assert.equal(resolution.state, "pinned")
  if (resolution.state !== "pinned") throw new Error("fixture did not pin")
  return resolution.pin
}

function request(fixture: Awaited<ReturnType<typeof setupReview>>): TaskRequest {
  return {
    kind: "contract-review",
    projectId,
    refs: { materials: fixture.materials.map(material => ({ materialVersionId: material.versionId, sha256: material.sha256 })) },
    conditions: { scene: "auto", role: "专业分包人", region: "上海", externalProcessingConsent: true, unreviewedMaterialsConsent: true },
  }
}

const candidate = (id: string): SceneCandidate => {
  const found = sceneCatalog().find(item => item.id === id)
  if (!found) throw new Error(`missing scene ${id}`)
  return found
}

const skillFor = (id: string): ReviewSkill => ({
  id: id as ReviewSkill["id"], name: "合成测试技能", version: "1", description: "测试", instructions: "测试指令", sha256: "a".repeat(64),
})

/** Code-side scene bundle used only for skill selection; its pack must never be used when pinned. */
function bundleFor(scene: string): SceneBundle {
  const value = {
    candidate: candidate(scene),
    pack: {
      manifest: { version: "file-fallback-forbidden", name: "文件规则包（不得用于固定任务）", status: "已发布" as const, ruleFiles: [], sourceFiles: [] },
      rules: [], sources: [], warnings: [],
    },
    skill: skillFor(candidate(scene).skillId),
  }
  return { ...value, sha256: "b".repeat(64) }
}

/** Deterministic published-mode machine result for the reviewWithAgent injection point. */
function publishedReviewResult(options: AgentReviewOptions): ReviewResult {
  const paragraphs = (options.paragraphs ?? []).map(paragraph => ({ index: paragraph.index, text: paragraph.text, inTable: false }))
  const input: ProjectReviewRunnerInput = {
    paragraphs: paragraphs.map(paragraph => ({ index: paragraph.index, text: paragraph.text, location: "测试材料" })),
    complete: options.complete ?? true,
    documentTitle: options.documentTitle ?? "测试专业分包合同",
    documentVersionId: options.documentVersionId ?? "version-1",
    parseSnapshotId: options.parseSnapshotId ?? "snapshot-1",
    textSha256: sha(paragraphs.map(paragraph => paragraph.text).join("\n")),
    context: { scene: "mep-sub-2026", role: "专业分包人", region: "上海" },
    maxCalls: 25,
    signal: new AbortController().signal,
    env: {},
    onBeforeCall: async () => {},
    onExchange: async () => {},
  }
  const result = successResult(input)
  result.mode = options.mode ?? "published"
  result.input.documentVersionId = options.documentVersionId ?? "version-1"
  result.input.parseSnapshotId = options.parseSnapshotId ?? "snapshot-1"
  return result
}

test("C6 pinned executor: DB pack runs in published mode and the saved result embeds the fixed refs", async () => {
  const fixture = await setupReview()
  try {
    const { repository, service } = await knowledgeService(fixture)
    const draft = await service.submit({
      kind: "rules", artifactId: "synthetic-contract-review", scene: "mep-sub-2026",
      content: publishableContent(), operatorId: operatorAccountId,
    })
    const published = await service.publish({
      versionId: draft.versionId, operatorId: operatorAccountId, reviewer: domainReviewer,
      verifiedAt: fixedNow, expectedSha256: draft.sha256, reviewEvidence: "合成测试核对证据：仅验证机制。",
    })
    assert.equal(published.state, "published")
    const pin = await publishedPin(repository)
    await fixture.tasks.submit(testIdentity.account.id, "pinned-review-1", request(fixture), { publications: pin })
    const job = await fixture.tasks.claimNext()
    assert.ok(job)
    assert.deepEqual(job.manifest.publications?.rules, pin.rules)

    let received: AgentReviewOptions | undefined
    const runner = createProjectReviewRunner({
      loadBundles: async () => [bundleFor("mep-sub-2026")],
      loadPublishedPack: ref => loadPublishedRulePack(repository, ref),
      review: async options => { received = options; return publishedReviewResult(options) },
    })
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner }))(job!, executorContext())
    assert.equal(outcome.outcome, "success")
    assert.ok(received)
    assert.equal(received.mode, "published")
    assert.equal(received.pack?.manifest.name, "合成测试规则包（C6 测试夹具，非法律规则）")
    assert.notEqual(received.pack?.manifest.version, "file-fallback-forbidden")
    assert.equal(received.pack?.rules.length, 1)
    assert.equal(received.pack?.rules[0].status, "已发布")

    const views = await fixture.results.list(testIdentity, testAuthorizer, projectId)
    assert.equal(views.length, 1)
    const view = views[0]
    assert.equal(view.validation.status, "valid")
    const value = view.value as PublishedReviewResult
    assert.equal(value.mode, "published")
    assert.deepEqual(value.publicationBasis, { rules: pin.rules, knowledge: [] })
    assert.ok(view.dependencies.some(dependency => dependency.kind === "rule" &&
      dependency.id === pin.rules[0].id && dependency.versionId === pin.rules[0].versionId))
    assert.deepEqual((view.provenance?.manifest as { publications?: PublicationPin }).publications, pin)
  } finally { await fixture.close() }
})

test("C6 pinned executor: a version disabled after submission still executes the pinned content with the retired-basis warning", async () => {
  const fixture = await setupReview()
  try {
    const { repository, service } = await knowledgeService(fixture)
    const draft = await service.submit({
      kind: "rules", artifactId: "synthetic-contract-review", scene: "mep-sub-2026",
      content: publishableContent(), operatorId: operatorAccountId,
    })
    const published = await service.publish({
      versionId: draft.versionId, operatorId: operatorAccountId, reviewer: domainReviewer,
      verifiedAt: fixedNow, expectedSha256: draft.sha256, reviewEvidence: "合成测试核对证据：仅验证机制。",
    })
    const pin = await publishedPin(repository)
    await fixture.tasks.submit(testIdentity.account.id, "pinned-review-retired", request(fixture), { publications: pin })
    const job = await fixture.tasks.claimNext()
    assert.ok(job)
    // Disable the pinned version after submission: the old task keeps its pin.
    await service.disable({ versionId: published.versionId, operatorId: operatorAccountId, reason: "合成测试：提交后停用" })
    const blocked = await resolvePublicationBasis(repository, {
      kind: "contract-review", projectId, refs: {}, conditions: { scene: "auto" },
    })
    assert.equal(blocked.state, "blocked")

    const runner = createProjectReviewRunner({
      loadBundles: async () => [bundleFor("mep-sub-2026")],
      loadPublishedPack: ref => loadPublishedRulePack(repository, ref),
      review: async options => publishedReviewResult(options),
    })
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner }))(job!, executorContext())
    assert.equal(outcome.outcome, "success")
    const views = await fixture.results.list(testIdentity, testAuthorizer, projectId)
    assert.equal(views.length, 1)
    const value = views[0].value as PublishedReviewResult
    assert.equal(value.mode, "published")
    assert.ok(value.warnings.includes(RETIRED_BASIS_WARNING))
    assert.deepEqual(value.publicationBasis?.rules, pin.rules)
    assert.equal(views[0].validation.status, "valid")
    // The official refs still describe published content (immutability), but new
    // submissions are blocked because the current version is disabled.
    assert.equal((await repository.getVersion(published.versionId))?.state, "disabled")
  } finally { await fixture.close() }
})

test("C6 pinned executor: a published-mode claim without the embedded fixed refs is rejected before saving", async () => {
  const fixture = await setupReview()
  try {
    const { repository, service } = await knowledgeService(fixture)
    const draft = await service.submit({
      kind: "rules", artifactId: "synthetic-contract-review", scene: "mep-sub-2026",
      content: publishableContent(), operatorId: operatorAccountId,
    })
    await service.publish({
      versionId: draft.versionId, operatorId: operatorAccountId, reviewer: domainReviewer,
      verifiedAt: fixedNow, expectedSha256: draft.sha256, reviewEvidence: "合成测试核对证据：仅验证机制。",
    })
    const pin = await publishedPin(repository)
    await fixture.tasks.submit(testIdentity.account.id, "pinned-review-nobasis", request(fixture), { publications: pin })
    const job = await fixture.tasks.claimNext()
    assert.ok(job)
    const runner: ProjectReviewRunner = async input => {
      const result = successResult(input)
      result.mode = "published"
      return result
    }
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner }))(job!, executorContext())
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "RESULT_MISMATCH")
    assert.equal((await fixture.results.list(testIdentity, testAuthorizer, projectId)).length, 0)
  } finally { await fixture.close() }
})

test("C6 pinned executor: a malformed manifest pin is rejected before any model call", async () => {
  const fixture = await setupReview()
  try {
    const job = await fixture.claim()
    let runnerCalls = 0
    const runner: ProjectReviewRunner = async input => { runnerCalls++; return successResult(input) }
    const tampered = {
      ...job,
      manifest: { ...job.manifest, publications: { rules: [], knowledge: [], templates: [] } },
    }
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner }))(tampered, executorContext())
    assert.equal(outcome.outcome, "failed")
    assert.equal(outcome.errorCode, "INVALID_SUBMISSION")
    assert.equal(runnerCalls, 0)
  } finally { await fixture.close() }
})

test("C6 old manifests/queued tasks without publications keep the debug path", async () => {
  const fixture = await setupReview()
  try {
    const job = await fixture.claim()
    assert.equal(job.manifest.publications, undefined)
    let received: AgentReviewOptions | undefined
    const runner = createProjectReviewRunner({
      loadBundles: async () => [bundleFor("mep-sub-2026")],
      review: async options => { received = options; return publishedReviewResult(options) },
    })
    const outcome = await createProjectReviewExecutor(executorDependencies(fixture, { runner }))(job, executorContext())
    assert.equal(outcome.outcome, "success")
    assert.equal(received?.mode, "debug")
    const views = await fixture.results.list(testIdentity, testAuthorizer, projectId)
    assert.equal(views.length, 1)
    const value = views[0].value as PublishedReviewResult
    assert.equal(value.mode, "debug")
    assert.equal(value.publicationBasis, undefined)
  } finally { await fixture.close() }
})

test("C6 manifest seam: publications cannot be submitted by the browser and old manifest JSON stays readable", async () => {
  const injection = () => parseTaskRequest({
    kind: "contract-review", projectId,
    refs: { materials: [{ materialVersionId: "version-1", sha256: "a".repeat(64) }] },
    conditions: { scene: "auto", role: "专业分包人", region: "上海", externalProcessingConsent: true, unreviewedMaterialsConsent: true },
    publications: { rules: [{ id: "publication-1", versionId: "version-1", sha256: "b".repeat(64) }], knowledge: [], templates: [] },
  })
  assert.throws(injection, (failure: unknown) => (failure as { code?: string }).code === "INVALID_SUBMISSION")
  const crossProject = () => parseTaskRequest({
    kind: "contract-review", projectId,
    refs: { materials: [{ projectId: "another-project", materialVersionId: "version-1", sha256: "a".repeat(64) }] },
    conditions: { scene: "auto", role: "专业分包人", region: "上海", externalProcessingConsent: true, unreviewedMaterialsConsent: true },
  })
  assert.throws(crossProject, (failure: unknown) => (failure as { code?: string }).code === "INVALID_SUBMISSION")

  const parsed = parseTaskRequest({
    kind: "contract-review", projectId, refs: { materials: [{ materialVersionId: "version-1", sha256: "c".repeat(64) }] },
    conditions: { scene: "auto", role: "专业分包人", region: "上海", externalProcessingConsent: true, unreviewedMaterialsConsent: true },
  })
  const oldManifest = buildTaskManifest(parsed, testIdentity.account.id, fixedNow)
  const decoded = JSON.parse(JSON.stringify(oldManifest)) as { publications?: PublicationPin }
  assert.equal(decoded.publications, undefined)
})
