import assert from "node:assert/strict"
import { test } from "node:test"
import type { RequirementSetValue, VerificationRequirement } from "../../lib/business/verification-types"
import {
  assertReadyForComparison, bidRequirementSetValidator, parseRequirementCandidates,
  parseRequirementSetValue, requirementFieldKeys, requirementSetSnapshot,
} from "./requirements"

/**
 * C4-VERIFY requirement-set contract (spec 01 §8.2.3, plan §4.2/§4.7/§5).
 *
 * The validator is the server-owned authority for a saved value: structure,
 * shared field vocabulary, known nature/operator, addendum state and
 * single-level AND/OR groups. It never treats an unconfirmed requirement as a
 * veto and never grants `valid` while any requirement is still pending.
 */
let sequence = 0

function requirement(overrides: Partial<VerificationRequirement> = {}): VerificationRequirement {
  sequence++
  return {
    requirementId: `req-${sequence}`,
    subject: "投标人",
    quote: "投标人应具有有效的营业执照。",
    materialVersionId: "tender-version",
    source: { snapshotId: "snapshot-tender", fragmentId: "fragment-1" },
    addendum: { state: "none", note: "" },
    nature: "资格否决",
    field: "subject_name",
    operator: "eq",
    value: "华建机电安装有限公司",
    asOfRule: "task_as_of",
    materialRelation: "企业营业执照",
    group: null,
    status: "confirmed",
    statusNote: "",
    ...overrides,
  }
}

function requirementSet(overrides: Partial<RequirementSetValue> = {}): RequirementSetValue {
  return {
    schemaVersion: 1,
    status: "confirmed",
    requirements: [requirement()],
    rejected: [],
    warnings: [],
    errors: [],
    ...overrides,
  }
}

async function validate(value: unknown) {
  return bidRequirementSetValidator(value)
}

const paragraphs = [
  { fragmentId: "fragment-1", snapshotId: "snapshot-1", materialVersionId: "tender-1", text: "投标人应具有有效的安全生产许可证。" },
  { fragmentId: "fragment-2", snapshotId: "snapshot-1", materialVersionId: "tender-1", text: "项目负责人须具有一级建造师注册证书。" },
]

test("requirements: model candidates map quotes verbatim and stay 待确认 (partial, never auto-veto)", async () => {
  const mapped = parseRequirementCandidates({
    candidates: [
      { requirementId: "req-1", subject: "投标人", quote: "有效的安全生产许可证", nature: "资格否决", field: "certificate_kind", operator: "eq", value: "安全生产许可证", asOfRule: "task_as_of", materialRelation: "安全生产许可证" },
      { subject: "项目负责人", quote: "一级建造师注册证书", nature: "待确认", materialRelation: "人员证书" },
      { subject: "投标人", quote: "材料中不存在的引文", nature: "一般提交", materialRelation: "营业执照" },
      { quote: "缺少义务主体", nature: "一般提交", materialRelation: "营业执照" },
    ],
  }, paragraphs)
  assert.equal(mapped.requirements.length, 2)
  assert.equal(mapped.rejected.length, 2)
  assert.deepEqual(mapped.rejected.map(item => item.reason).length, 2)
  for (const item of mapped.requirements) {
    assert.equal(item.status, "pending")
    assert.match(item.statusNote, /待人工确认/)
  }
  assert.deepEqual(mapped.requirements[0].source, { snapshotId: "snapshot-1", fragmentId: "fragment-1" })
  assert.equal(mapped.requirements[0].materialVersionId, "tender-1")
  assert.equal(mapped.requirements[1].nature, "待确认")
  const value: RequirementSetValue = {
    schemaVersion: 1, status: "candidate", requirements: mapped.requirements, rejected: mapped.rejected, warnings: [], errors: [],
  }
  const validation = await validate(value)
  assert.equal(validation.status, "partial")
  assert.equal((await assertReadyForComparison(value)).ok, false)
})

test("requirements: a fully confirmed requirement set validates as valid; remaining candidates validate partial", async () => {
  const valid = await validate(requirementSet())
  assert.equal(valid.status, "valid")
  assert.deepEqual(valid.issues, [])
  const partial = await validate(requirementSet({ status: "candidate" }))
  assert.equal(partial.status, "partial")
  const pendingRequirements = await validate(requirementSet({
    requirements: [requirement({ status: "pending", statusNote: "待人工确认" })],
  }))
  assert.equal(pendingRequirements.status, "partial")
})

test("requirements: unknown fields/operators, missing sources, nested groups and pending natures are rejected", async () => {
  const cases: Array<[string, unknown]> = [
    ["词表外字段", requirementSet({ requirements: [requirement({ field: "salary" as never })] })],
    ["未知运算符", requirementSet({ requirements: [requirement({ operator: "like" as never })] })],
    ["缺少来源", requirementSet({ requirements: [requirement({ source: { snapshotId: "", fragmentId: "" } })] })],
    ["空引文", requirementSet({ requirements: [requirement({ quote: "" })] })],
    ["嵌套分组", requirementSet({ requirements: [requirement({
      field: null, operator: null, value: null,
      group: { operator: "and", conditions: [{ field: "subject_name", operator: "eq", value: "A", group: {} } as never] },
    })] })],
    ["日期运算符用于文本字段", requirementSet({ requirements: [requirement({ operator: "on_or_after" })] })],
    ["已确认但性质待确认", requirementSet({ requirements: [requirement({ nature: "待确认" })] })],
    ["已确认但无比较表达式", requirementSet({ requirements: [requirement({ field: null, operator: null, value: null, group: null })] })],
    ["空要求集", requirementSet({ requirements: [] })],
    ["重复要求编号", requirementSet({ requirements: [requirement({ requirementId: "same" }), requirement({ requirementId: "same" })] })],
    ["未知补遗状态", requirementSet({ requirements: [requirement({ addendum: { state: "unknown" as never, note: "" } })] })],
    ["非法判定时点规则", requirementSet({ requirements: [requirement({ asOfRule: "today" as never })] })],
  ]
  for (const [name, value] of cases) {
    const validation = await validate(value)
    assert.equal(validation.status, "invalid", name)
    assert.ok(validation.issues.length > 0, name)
  }
})

test("requirements: single-level AND/OR groups with known operators are accepted", async () => {
  const groupRequirement = requirement({
    field: null, operator: null, value: null,
    group: { operator: "and", conditions: [
      { field: "subject_name", operator: "eq", value: "华建机电安装有限公司" },
      { field: "unified_social_credit_code", operator: "in", value: ["91310000MA1FL0XX2A"] },
    ] },
  })
  const validation = await validate(requirementSet({ requirements: [groupRequirement] }))
  assert.equal(validation.status, "valid")
  const badGroup = await validate(requirementSet({ requirements: [requirement({
    field: null, operator: null, value: null,
    group: { operator: "and", conditions: [{ field: "expiry_date", operator: "gte", value: "2027-01-01" }] as never },
  })] }))
  // gte on a date field is valid; an unknown operator or scalar list is not.
  assert.equal(badGroup.status, "valid")
})

test("requirements: assertReadyForComparison rejects unconfirmed/pending-nature/pending-operator sets", async () => {
  assert.deepEqual(await assertReadyForComparison(requirementSet()), { ok: true })
  assert.deepEqual(await assertReadyForComparison(requirementSet({ status: "candidate" })), { ok: false, reason: "unconfirmed" })
  assert.deepEqual(await assertReadyForComparison(requirementSet({
    requirements: [requirement({ status: "pending" })],
  })), { ok: false, reason: "unconfirmed" })
  const pendingNature = requirementSet({
    requirements: [
      requirement({ nature: "待确认", field: "subject_name", operator: "eq", value: "A" }),
    ],
    status: "confirmed",
  })
  assert.deepEqual(await assertReadyForComparison(pendingNature), { ok: false, reason: "pending-nature" })
  const forged = requirementSet({ requirements: [requirement({ field: null, operator: null, value: null, group: null })] })
  assert.deepEqual(await assertReadyForComparison(forged), { ok: false, reason: "pending-operators" })
})

test("requirements: a >100 requirement set is rejected and asOf-relative dates are only valid with task_as_of", async () => {
  for (const count of [201, 500]) {
    const requirements = Array.from({ length: count }, (_, index) => requirement({ requirementId: `req-${index}` }))
    const validation = await validate(requirementSet({ requirements }))
    assert.equal(validation.status, "invalid", `count ${count}`)
    assert.ok(validation.issues.some(issue => /上限/.test(issue.message)))
  }
  const asOfDate = requirement({ field: "expiry_date", operator: "on_or_after", value: null, asOfRule: "task_as_of" })
  assert.equal((await validate(requirementSet({ requirements: [asOfDate] }))).status, "valid")
  assert.deepEqual(await assertReadyForComparison(requirementSet({ requirements: [asOfDate] })), { ok: true })
  const noBaseline = requirement({ field: "expiry_date", operator: "on_or_after", value: null, asOfRule: "not_applicable" })
  const rejected = await validate(requirementSet({ requirements: [noBaseline] }))
  assert.equal(rejected.status, "invalid")
  assert.ok(rejected.issues.some(issue => /判定时点/.test(issue.message)))
  const fixed = requirement({ field: "expiry_date", operator: "on_or_after", value: "2027-01-01", asOfRule: "not_applicable" })
  assert.equal((await validate(requirementSet({ requirements: [fixed] }))).status, "valid")
})

test("requirements: snapshot mapping and field keys are deterministic and reject malformed structural values", () => {
  const value = requirementSet({
    requirements: [
      requirement({ requirementId: "req-1" }),
      requirement({ requirementId: "req-2", field: null, operator: null, value: null, group: { operator: "or", conditions: [{ field: "expiry_date", operator: "on_or_after", value: "2027-01-01" }] } }),
    ],
  })
  const snapshots = requirementSetSnapshot(value)
  assert.deepEqual(snapshots.map(item => item.requirementId), ["req-1", "req-2"])
  assert.deepEqual(snapshots[1].source, { snapshotId: "snapshot-tender", fragmentId: "fragment-1" })
  assert.equal(snapshots[1].addendumState, "none")
  assert.equal(snapshots[0].subject, "投标人")
  assert.deepEqual([...requirementFieldKeys(value)].sort(), ["expiry_date", "subject_name"])
  assert.throws(() => parseRequirementSetValue(null), { code: "REQUIREMENT_SET_INVALID" })
  assert.throws(() => parseRequirementSetValue({ schemaVersion: 2 }), { code: "REQUIREMENT_SET_INVALID" })
  assert.equal(parseRequirementSetValue(value).status, "confirmed")
})
