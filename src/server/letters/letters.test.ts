import assert from "node:assert/strict"
import { test } from "node:test"
import type { CollectionLetterDraft } from "@/lib/letters/types"
import type { ProjectFactVersion } from "@/lib/facts/types"
import { FactError } from "@/lib/facts/types"
import type { AuthIdentity } from "../auth/service"
import { BusinessError } from "../projects/errors"
import type { ResultAuthorizer, ResultView } from "../results/service"
import { LetterService } from "./service"
import { collectionLetterValidator, parseCollectionLetterValue } from "./validation"

const identity = { account: { id: "account-1", username: "editor", role: "member" }, session: { id: "session-1", expiresAt: 0 } } as AuthIdentity
const authorize: ResultAuthorizer = async (_, projectId, action) => ({ projectId, action, role: "editor", identity })
const sha = "a".repeat(64)

const paymentValue = {
  schemaVersion: 1, cutoff: "2026-10-30", status: "conditional",
  rows: [
    { rowId: "r1", nature: "计付基数", amountFen: "100000000", taxBasis: "含税", basis: "本期", periodStart: "2026-09-01", periodEnd: "2026-09-30", ratio: "0.8", dueDate: "2026-10-20", conditionMet: true, payer: "示例发包人", payee: "示例专业分包人", confirmation: "已确认" },
    { rowId: "r2", nature: "付款", amountFen: "30000000", taxBasis: "含税", basis: "本期", periodStart: "2026-09-01", periodEnd: "2026-09-30", eventDate: "2026-10-25", payer: "示例发包人", payee: "示例专业分包人", confirmation: "已确认" },
  ],
  facts: [], notes: [], calculation: { netDueFen: "80000000", paidFen: "30000000", unpaidFen: "50000000", formula: "800000.00 − 300000.00 = 500000.00 元" },
}

const paymentView: ResultView = { projectId: "project-1", resultId: "payment-1", versionId: "payment-v1", sha256: sha, kind: "payment-reconciliation",
  value: paymentValue, machineOutput: null, origin: "human", sources: [], dependencies: [], provenance: null,
  validation: { status: "valid", versionId: "payment-v1", checkedAt: "2026-10-30T00:00:00.000Z", issues: [] }, review: null,
  createdAt: "2026-10-30T00:00:00.000Z", createdBy: "account-1", reason: "款项核对" }

const fact = (overrides: Partial<ProjectFactVersion> = {}): ProjectFactVersion => ({ projectId: "project-1", factId: "fact-1", factVersionId: "fact-v1", version: 1,
  field: "计付基数", nature: "材料记载", selectedValue: "1000000.00", sources: [], conflicts: [], confirmation: "已确认", support: "材料支持",
  evidenceStatus: "材料支持", sha256: "b".repeat(64), createdAt: "2026-10-30T00:00:00.000Z", createdBy: "account-1", ...overrides })

const draft = (overrides: Partial<CollectionLetterDraft> = {}): CollectionLetterDraft => ({
  cutoff: "2026-10-30", contractTitle: "示例专业分包合同", sender: "示例专业分包人", recipient: "示例发包人",
  demand: "于收到本函后十日内支付上述款项", plannedDate: "2026-11-02", method: "邮寄", address: "上海市示例路 1 号",
  payment: { resultId: "payment-1", versionId: "payment-v1", sha256: sha }, factVersionIds: ["fact-v1"], ...overrides,
})

function service(options: { payment?: ResultView | null; evidence?: ResultView; facts?: Map<string, ProjectFactVersion> } = {}) {
  const saved: unknown[] = []
  const instance = new LetterService({
    results: {
      get: async (_identity, _authorize, _projectId, resultId, versionId) => {
        if (options.evidence && resultId === options.evidence.resultId && versionId === options.evidence.versionId) return options.evidence
        if (options.payment === null) throw new BusinessError("NOT_FOUND", "找不到成果。")
        return options.payment ?? paymentView
      },
      saveResultRevision: async (_identity, _authorize, input) => { saved.push(input); return { ...paymentView, ...input, resultId: input.resultId ?? "letter-1", versionId: "letter-v1" } as ResultView },
    },
    facts: { version: async (projectId, factVersionId) => {
      const known = options.facts?.get(factVersionId) ?? (factVersionId === "fact-v1" ? fact() : undefined)
      if (!known || known.projectId !== projectId) throw new FactError("FACT_NOT_FOUND", "找不到事实版本。")
      return known
    } },
    readProjectRetention: async () => "2026-11-30",
  })
  return { instance, saved }
}

test("AC-07/11: a complete letter renders deterministically from the selected payment version", async () => {
  const { instance, saved } = service()
  const result = await instance.save(identity, authorize, "project-1", { operationId: "letter-1", reason: "生成催款函", baseVersionId: "", value: draft() })
  assert.equal(result.kind, "collection-letter")
  const input = saved[0] as { kind: string; value: { status: string; paragraphs: string[]; payment: { unpaidFen: string } }; dependencies: Array<{ kind: string }> }
  assert.equal(input.kind, "collection-letter")
  assert.equal(input.value.status, "ready")
  assert.equal(input.value.payment.unpaidFen, "50000000")
  assert.ok(input.value.paragraphs.some(line => line.includes("500000.00")))
  assert.ok(input.value.paragraphs.some(line => line.includes("本函尚未发送")))
  assert.ok(input.dependencies.some(dependency => dependency.kind === "result"))
  assert.equal((await collectionLetterValidator(input.value)).status, "valid")
})

test("AC-11/22: missing send-plan fields keep the letter a draft that cannot be approved", async () => {
  const { instance, saved } = service()
  await instance.save(identity, authorize, "project-1", { operationId: "letter-2", reason: "生成草稿", baseVersionId: "", value: draft({ address: "", plannedDate: "" }) })
  const value = (saved[0] as { value: { status: string; missing: string[] } }).value
  assert.equal(value.status, "draft")
  assert.ok(value.missing.includes("拟送达地址"))
  const validation = await collectionLetterValidator(value)
  assert.equal(validation.status, "partial")
  assert.equal(validation.issues[0].code, "LETTER_INCOMPLETE")
})

test("AC-11/15: unavailable payment, zero balance, party mismatch and unconfirmed facts are refused", async () => {
  await assert.rejects(service({ payment: null }).instance.save(identity, authorize, "project-1", { operationId: "l", reason: "生成", baseVersionId: "", value: draft() }), { code: "INVALID_SOURCE" })
  const zero = { ...paymentView, value: { ...paymentValue, calculation: { ...paymentValue.calculation, unpaidFen: "0" } } }
  await assert.rejects(service({ payment: zero }).instance.save(identity, authorize, "project-1", { operationId: "l", reason: "生成", baseVersionId: "", value: draft() }), { code: "INVALID_SOURCE" })
  const invalid = { ...paymentView, validation: { ...paymentView.validation, status: "partial" as const } }
  await assert.rejects(service({ payment: invalid }).instance.save(identity, authorize, "project-1", { operationId: "l", reason: "生成", baseVersionId: "", value: draft() }), { code: "INVALID_SOURCE" })
  await assert.rejects(service().instance.save(identity, authorize, "project-1", { operationId: "l", reason: "生成", baseVersionId: "", value: draft({ recipient: "其他主体" }) }), { code: "INVALID_SOURCE" })
  const facts = new Map([["fact-v1", fact({ confirmation: "未确认" })]])
  await assert.rejects(service({ facts }).instance.save(identity, authorize, "project-1", { operationId: "l", reason: "生成", baseVersionId: "", value: draft() }), { code: "INVALID_SOURCE" })
  const foreign = new Map([["fact-v1", fact({ projectId: "other-project" })]])
  await assert.rejects(service({ facts: foreign }).instance.save(identity, authorize, "project-1", { operationId: "l", reason: "生成", baseVersionId: "", value: draft() }), { code: "INVALID_SOURCE" })
  const viewer: ResultAuthorizer = async (who, projectId, action) => ({ projectId, action, role: "viewer", identity: who })
  await assert.rejects(service().instance.save(identity, viewer, "project-1", { operationId: "l", reason: "生成", baseVersionId: "", value: draft() }), { code: "FORBIDDEN" })
})

test("AC-11: an incomplete evidence report is recorded as a missing item, not as a complete basis", async () => {
  const evidence: ResultView = { ...paymentView, resultId: "evidence-1", versionId: "evidence-v1", kind: "evidence-report", value: { schemaVersion: 1, status: "incomplete" } }
  const { instance, saved } = service({ evidence })
  await instance.save(identity, authorize, "project-1", { operationId: "l", reason: "生成", baseVersionId: "", value: draft({ evidence: { resultId: "evidence-1", versionId: "evidence-v1", sha256: sha } }) })
  const value = (saved[0] as { value: { status: string; missing: string[] } }).value
  assert.equal(value.status, "draft")
  assert.ok(value.missing.some(item => item.includes("证据整理")))
})

test("letter validator rejects rewritten paragraphs or status", async () => {
  const { instance, saved } = service()
  await instance.save(identity, authorize, "project-1", { operationId: "l", reason: "生成", baseVersionId: "", value: draft() })
  const value = (saved[0] as { value: Record<string, unknown> }).value
  assert.equal((await collectionLetterValidator({ ...value, status: "draft" })).status, "invalid")
  assert.equal((await collectionLetterValidator({ ...value, paragraphs: ["被改写的正文"] })).status, "invalid")
  assert.equal(parseCollectionLetterValue({ ...value, extra: 1 }), null)
})
