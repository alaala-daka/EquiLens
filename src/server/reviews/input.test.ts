import assert from "node:assert/strict"
import { test } from "node:test"
import { loadReviewInput, retentionExpired, type ReviewInputDependencies } from "./input"
import { setupReview, projectId, type ReviewFixture } from "./test-fixtures"

const fixedNow = () => new Date("2026-10-29T00:00:00.000Z")

function loader(fixture: ReviewFixture, overrides: Partial<ReviewInputDependencies> = {}): ReviewInputDependencies {
  return {
    repository: fixture.repository,
    store: fixture.store,
    readProjectRetention: async () => fixture.projectRetention,
    refreshAccess: async () => {},
    now: fixedNow,
    ...overrides,
  }
}

test("A4c input: loads the referenced version, latest snapshot and fragment locations", async () => {
  const fixture = await setupReview()
  try {
    const job = await fixture.claim()
    const loaded = await loadReviewInput(loader(fixture), job)
    assert.equal(loaded.paragraphs.length, 2)
    assert.deepEqual(loaded.paragraphs.map(paragraph => paragraph.index), [0, 1])
    assert.equal(loaded.paragraphs[0].text, "合同价款按月度计量支付。")
    assert.match(loaded.paragraphs[0].location, /测试专业分包合同 第 1 段/)
    assert.equal(loaded.complete, true)
    assert.equal(loaded.documentTitle, "测试专业分包合同")
    assert.equal(loaded.documentVersionId, fixture.materials[0].versionId)
    assert.equal(loaded.parseSnapshotId, fixture.materials[0].snapshotId)
    assert.match(loaded.textSha256, /^[a-f0-9]{64}$/)
    const source = loaded.paragraphSources.get(0)
    assert.equal(source?.fragmentId, "fragment-1-0")
    assert.equal(source?.snapshotId, fixture.materials[0].snapshotId)
    assert.equal(source?.fragmentText, loaded.paragraphs[0].text)
    assert.equal(loaded.unreviewedMaterialsConsent, true)
    assert.equal(loaded.materials.length, 1)
  } finally { await fixture.close() }
})

test("A4c input: merges multiple materials into one indexed paragraph list with per-fragment sources", async () => {
  const fixture = await setupReview()
  try {
    const second = await fixture.addMaterial(["补充协议约定质保金比例。"], { title: "补充协议" })
    const job = await fixture.claim([
      { materialVersionId: fixture.materials[0].versionId, sha256: fixture.materials[0].sha256 },
      { materialVersionId: second.versionId, sha256: second.sha256 },
    ])
    const loaded = await loadReviewInput(loader(fixture), job)
    assert.equal(loaded.paragraphs.length, 3)
    assert.deepEqual(loaded.paragraphs.map(paragraph => paragraph.index), [0, 1, 2])
    assert.deepEqual([...new Set([...loaded.paragraphSources.values()].map(source => source.snapshotId))].sort(),
      [fixture.materials[0].snapshotId, second.snapshotId].sort())
    assert.equal(loaded.documentTitle, "测试专业分包合同 等 2 份材料")
    assert.equal(loaded.materials.length, 2)
  } finally { await fixture.close() }
})

test("A4c input: partial parse coverage marks the review input incomplete but remains reviewable", async () => {
  const fixture = await setupReview({ coverage: { status: "partial", findings: [{ code: "embedded_image", location: "图片 1 处" }], pageCount: null, textLength: 30 } })
  try {
    const loaded = await loadReviewInput(loader(fixture), await fixture.claim())
    assert.equal(loaded.complete, false)
  } finally { await fixture.close() }
})

test("A4c input: failed parse coverage is rejected as an unusable source", async () => {
  const fixture = await setupReview({ coverage: { status: "failed", findings: [{ code: "no_text", location: "正文" }], pageCount: null, textLength: 0 } })
  try {
    await assert.rejects(loadReviewInput(loader(fixture), await fixture.claim()), { code: "INVALID_SOURCE" })
  } finally { await fixture.close() }
})

test("A4c input: digest mismatch, deleted material, missing object and empty fragments are rejected", async () => {
  const digestFixture = await setupReview()
  try {
    const job = await digestFixture.claim([{ materialVersionId: digestFixture.materials[0].versionId, sha256: "b".repeat(64) }])
    await assert.rejects(loadReviewInput(loader(digestFixture), job), { code: "INVALID_SOURCE" })
  } finally { await digestFixture.close() }

  const deleted = await setupReview()
  try {
    const job = await deleted.claim()
    await deleted.database.transaction(async connection => {
      await connection.query("UPDATE equilens_materials SET status='deleted'")
    })
    await assert.rejects(loadReviewInput(loader(deleted), job), { code: "INVALID_SOURCE" })
  } finally { await deleted.close() }

  const noObject = await setupReview()
  try {
    const job = await noObject.claim()
    await noObject.store.delete(noObject.materials[0].objectKey)
    await assert.rejects(loadReviewInput(loader(noObject), job), { code: "INVALID_SOURCE" })
  } finally { await noObject.close() }

  const noFragments = await setupReview()
  try {
    const job = await noFragments.claim()
    await noFragments.database.transaction(async connection => {
      await connection.query("DELETE FROM equilens_source_fragments")
    })
    await assert.rejects(loadReviewInput(loader(noFragments), job), { code: "INVALID_SOURCE" })
  } finally { await noFragments.close() }
})

test("A4c input: expired project/material retention stops before any model input is built", async () => {
  const expiredMaterial = await setupReview({ materialRetention: "2020-01-01" })
  try {
    await assert.rejects(loadReviewInput(loader(expiredMaterial), await expiredMaterial.claim()), { code: "RETENTION_EXPIRED" })
  } finally { await expiredMaterial.close() }

  const expiredProject = await setupReview({ projectRetention: "2020-01-01" })
  try {
    await assert.rejects(loadReviewInput(loader(expiredProject), await expiredProject.claim()), { code: "RETENTION_EXPIRED" })
  } finally { await expiredProject.close() }
  assert.equal(retentionExpired("2020-01-01", fixedNow()), true)
  assert.equal(retentionExpired("2099-12-31", fixedNow()), false)
})

test("A4c input: a newer material version invalidates the submitted version instead of reviewing new content", async () => {
  const fixture = await setupReview()
  try {
    const job = await fixture.claim()
    const secondVersion = "44444444-4444-4444-8444-999999999999"
    const secondSnapshot = "55555555-5555-4555-8555-999999999999"
    await fixture.database.transaction(async connection => {
      await connection.query(
        "INSERT INTO equilens_material_versions(id,project_id,material_id,revision,sha256,size_bytes,content_type,object_key,file_name,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [secondVersion, projectId, fixture.materials[0].materialId, 2, "c".repeat(64), 1,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "projects/" + projectId + "/materials/" + fixture.materials[0].materialId + "/versions/" + secondVersion + "/" + "c".repeat(64), null, "2026-10-29T00:00:00.000Z"],
      )
      await connection.query(
        "INSERT INTO equilens_parse_snapshots(id,project_id,material_id,version_id,revision,parser,parser_version,coverage,page_count,text_length,coverage_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [secondSnapshot, projectId, fixture.materials[0].materialId, secondVersion, 2, "docx-ooxml", "c2-docx-1", "available", null, 4, JSON.stringify({ status: "available", findings: [], pageCount: null, textLength: 4 }), "2026-10-29T00:00:00.000Z"],
      )
      await connection.query("UPDATE equilens_materials SET latest_revision=2, latest_version_id=$1", [secondVersion])
    })
    await assert.rejects(loadReviewInput(loader(fixture), job), { code: "INVALID_SOURCE" })
  } finally { await fixture.close() }
})

test("A4c input: merged text over the review input cap fails without sending material to the model", async () => {
  const fixture = await setupReview()
  try {
    await assert.rejects(loadReviewInput(loader(fixture, { maxTextCharacters: 5 }), await fixture.claim()), { code: "REVIEW_INPUT_TOO_LARGE" })
  } finally { await fixture.close() }
})
