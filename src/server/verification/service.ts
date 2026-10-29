import type {
  RequirementSetValue, VerificationEvidence, VerificationExternalRecordView, VerificationListSummary,
  VerificationStaleState,
} from "../../lib/business/verification-types"
import { EXTERNAL_RECORD_CONCLUSIONS, isVerificationResultKind } from "../../lib/business/verification-types"
import { quotesMatch } from "../../lib/business/verification-fields"
import type { AuthIdentity } from "../auth/service"
import type { MaterialRepository } from "../materials/repository"
import { BusinessError } from "../projects/errors"
import { retentionExpired } from "../reviews/input"
import type { ResultAuthorizer, ResultDependency, ResultService, ResultSource, ResultView } from "../results/service"
import type { FieldSource, VerificationFieldValue } from "./field-source"
import { inspectRequirementSet, MAX_REQUIREMENTS } from "./requirements"
import type { VerificationRecordRepository, VerificationRecordRow } from "./records-repository"
import { evidenceDigest, recordListDigest, text } from "./types"

/**
 * C4-VERIFY server-owned services (spec 01 §8.2.3, plan §4.7/§4.9).
 *
 * - `saveRequirementSet` is the only write path for a human-confirmed
 *   requirement set: it re-reads every requirement's material version, parse
 *   snapshot and fragment in the project, verifies the quote verbatim
 *   (`quotesMatch`, whitespace-normalized), rejects inactive/expired/foreign
 *   sources, assembles `sources` and delegates to the server-owned result save.
 *   The generic browser results POST can never write `bid-requirements`.
 * - `recordExternalVerification` appends a manual verification record for a
 *   saved `bid-verification` version; it never rewrites the saved result. The
 *   saved evidence is append-only and pinned by digest in later task manifests.
 * - `list`/`get` expose only the two C4 result kinds, plus the honest
 *   "记录/字段已更新，需重新运行" hint by comparing the current append-only
 *   records and current field values with the snapshots embedded in the result.
 */
export type SaveRequirementSetInput = {
  projectId: string
  resultId?: string
  baseVersionId: string
  operationId: string
  reason: string
  value: unknown
}

export type RecordExternalVerificationInput = {
  projectId: string
  resultId: string
  versionId: string
  sha256: string
  requirementId: string
  subject: string
  certificateNo: string
  source: string
  queriedAt: string
  queryConditions: string
  conclusion: string
  proofMaterialVersionId: string
}

export type VerificationDetail = {
  result: ResultView
  records: VerificationExternalRecordView[]
  stale: VerificationStaleState
}

export type VerificationServiceDependencies = {
  materials: Pick<MaterialRepository, "versionById" | "findMaterial" | "findSnapshot" | "findFragment">
  results: ResultService
  records: VerificationRecordRepository
  fieldSource: FieldSource
  readProjectRetention: (projectId: string) => Promise<string | null>
  now?: () => Date
}

const MAX_SUBJECT = 200
const MAX_CERTIFICATE = 128
const MAX_SOURCE = 500
const MAX_QUERY_CONDITIONS = 500
/** Raw requirement-set value cap (well under the 256 KiB HTTP body limit). */
const MAX_VALUE_CHARS = 200_000
const STALE_HINT = "记录/字段已更新，需重新运行。"

function externalRecordView(row: VerificationRecordRow): VerificationExternalRecordView {
  return {
    recordId: row.recordId,
    requirementSetVersionId: row.requirementSetVersionId,
    requirementId: row.requirementId,
    subject: row.subject,
    certificateNo: row.certificateNo,
    source: row.source,
    queriedAt: row.queriedAt,
    queryConditions: row.queryConditions,
    conclusion: row.conclusion,
    proofMaterialVersionId: row.proofMaterialVersionId,
    sha256: row.sha256,
    createdAt: row.createdAt,
  }
}

function embeddedVerificationValue(value: unknown): {
  requirementSetVersionId: string
  requirementIds: Set<string>
  materialVersionIds: string[]
  fieldKeys: Set<string>
  embeddedEvidence: VerificationEvidence[]
  embeddedRecords: Array<{ recordId: string; sha256: string }>
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const root = value as Record<string, unknown>
  const set = root.requirementSet as Record<string, unknown> | undefined
  if (!set || typeof set.versionId !== "string") return null
  const requirements = Array.isArray(set.requirements) ? set.requirements as Array<Record<string, unknown>> : []
  const requirementIds = new Set<string>()
  const fieldKeys = new Set<string>()
  for (const requirement of requirements) {
    if (typeof requirement?.requirementId !== "string") return null
    requirementIds.add(requirement.requirementId)
    if (typeof requirement.field === "string") fieldKeys.add(requirement.field)
    const group = requirement.group as { conditions?: unknown[] } | null | undefined
    if (group && Array.isArray(group.conditions)) {
      for (const condition of group.conditions as Array<Record<string, unknown>>) {
        if (typeof condition?.field === "string") fieldKeys.add(condition.field)
      }
    }
  }
  const materials = Array.isArray(root.materials) ? root.materials as Array<Record<string, unknown>> : []
  const materialVersionIds = materials.map(material => text(material.versionId)).filter(Boolean)
  const embeddedEvidence: VerificationEvidence[] = []
  const seenEvidence = new Set<string>()
  for (const item of (Array.isArray(root.items) ? root.items : []) as Array<Record<string, unknown>>) {
    for (const raw of (Array.isArray(item.evidence) ? item.evidence : []) as unknown[]) {
      const evidence = raw as Record<string, unknown>
      if (typeof evidence?.fieldKey !== "string" || !fieldKeys.has(evidence.fieldKey)) continue
      const key = `${evidence.materialVersionId}\u0000${evidence.subjectKey}\u0000${evidence.fieldKey}\u0000${String(evidence.valueText)}\u0000${String(evidence.origin)}`
      if (seenEvidence.has(key)) continue
      seenEvidence.add(key)
      embeddedEvidence.push(evidence as unknown as VerificationEvidence)
    }
  }
  const embeddedRecords = ((Array.isArray(root.records) ? root.records : []) as Array<Record<string, unknown>>)
    .map(record => ({ recordId: text(record.recordId), sha256: text(record.sha256) }))
    .filter(record => record.recordId && record.sha256)
  return { requirementSetVersionId: set.versionId, requirementIds, materialVersionIds, fieldKeys, embeddedEvidence, embeddedRecords }
}

export class VerificationService {
  constructor(private readonly dependencies: VerificationServiceDependencies) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date()
  }

  private async assertEditable(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string) {
    const access = await authorize(identity, projectId, "edit")
    if (access.projectId !== projectId || access.role === "viewer") throw new BusinessError("FORBIDDEN", "无权操作该核验成果。")
    return access
  }

  private async assertRetention(projectId: string): Promise<void> {
    const retention = await this.dependencies.readProjectRetention(projectId)
    if (!retention) throw new BusinessError("SERVICE_UNAVAILABLE", "项目或材料保留期限不可用，请稍后重试。")
    if (retentionExpired(retention, this.now())) throw new BusinessError("INVALID_SOURCE", "项目或材料已超过保留期限，不能保存核验数据。")
  }

  /**
   * Human confirmation/correction of a requirement set. Re-reads every source
   * before saving; a forged or mismatched quote is rejected, not saved as invalid.
   */
  async saveRequirementSet(identity: AuthIdentity, authorize: ResultAuthorizer, input: SaveRequirementSetInput): Promise<ResultView> {
    await this.assertEditable(identity, authorize, input.projectId)
    // Server-owned save caps: bound both the requirement count and the raw value
    // size so a browser cannot store an unbounded "requirement set" object.
    if (JSON.stringify(input.value ?? null).length > MAX_VALUE_CHARS) throw new BusinessError("INVALID_INPUT", "要求集内容超过保存上限。")
    const rawRequirements = (input.value as { requirements?: unknown } | null)?.requirements
    if (Array.isArray(rawRequirements) && rawRequirements.length > MAX_REQUIREMENTS) {
      throw new BusinessError("INVALID_INPUT", `要求数量超过上限（最多 ${MAX_REQUIREMENTS} 条）。`)
    }
    const inspected = inspectRequirementSet(input.value)
    if (!inspected.value) throw new BusinessError("INVALID_INPUT", "要求集结构无效，不能保存。")
    const value: RequirementSetValue = inspected.value
    await this.assertRetention(input.projectId)
    const sources: ResultSource[] = []
    const dependencies: ResultDependency[] = []
    const seenSources = new Set<string>()
    const seenMaterials = new Set<string>()
    for (const requirement of value.requirements) {
      const version = await this.dependencies.materials.versionById(input.projectId, requirement.materialVersionId)
      if (!version) throw new BusinessError("INVALID_INPUT", "要求引用的材料版本无效。")
      const material = await this.dependencies.materials.findMaterial(input.projectId, version.materialId)
      if (!material || material.status !== "active" || !material.processingAuthorized) {
        throw new BusinessError("INVALID_INPUT", "要求引用的材料版本不可用。")
      }
      if (retentionExpired(material.retentionUntil, this.now())) {
        throw new BusinessError("INVALID_SOURCE", "要求引用的材料已超过保留期限。")
      }
      const snapshot = await this.dependencies.materials.findSnapshot(input.projectId, requirement.source.snapshotId)
      if (!snapshot || snapshot.materialId !== version.materialId || snapshot.versionId !== version.id) {
        throw new BusinessError("INVALID_INPUT", "要求引用的解析快照与材料版本不一致。")
      }
      const fragment = await this.dependencies.materials.findFragment(input.projectId, snapshot.id, requirement.source.fragmentId)
      if (!fragment || !quotesMatch(fragment.text, requirement.quote)) {
        throw new BusinessError("INVALID_INPUT", "要求引文与来源片段原文不一致，不能保存。")
      }
      if (!seenSources.has(fragment.id)) {
        seenSources.add(fragment.id)
        sources.push({ fragmentId: fragment.id, snapshotId: snapshot.id, quote: fragment.text })
      }
      if (!seenMaterials.has(version.id)) {
        seenMaterials.add(version.id)
        dependencies.push({ kind: "material", id: material.id, versionId: version.id })
      }
    }
    return this.dependencies.results.saveResultRevision(identity, authorize, {
      projectId: input.projectId,
      ...(input.resultId ? { resultId: input.resultId } : {}),
      kind: "bid-requirements",
      baseVersionId: input.baseVersionId,
      operationId: input.operationId,
      reason: input.reason,
      value,
      sources,
      dependencies,
    }, undefined, { serverOwned: true })
  }

  /** Append manual external-verification evidence for one requirement of a saved comparison. */
  async recordExternalVerification(identity: AuthIdentity, authorize: ResultAuthorizer, input: RecordExternalVerificationInput): Promise<VerificationExternalRecordView> {
    await this.assertEditable(identity, authorize, input.projectId)
    const subject = text(input.subject)
    const certificateNo = text(input.certificateNo)
    const source = text(input.source)
    const queriedAt = text(input.queriedAt)
    const queryConditions = text(input.queryConditions)
    const conclusion = text(input.conclusion)
    const requirementId = text(input.requirementId)
    const proofMaterialVersionId = text(input.proofMaterialVersionId)
    if (!subject || subject.length > MAX_SUBJECT || !certificateNo || certificateNo.length > MAX_CERTIFICATE ||
      !source || source.length > MAX_SOURCE || !queriedAt || queriedAt.length > 32 || !Number.isFinite(Date.parse(queriedAt)) ||
      !queryConditions || queryConditions.length > MAX_QUERY_CONDITIONS || !requirementId || !proofMaterialVersionId ||
      !(EXTERNAL_RECORD_CONCLUSIONS as readonly string[]).includes(conclusion)) {
      throw new BusinessError("INVALID_INPUT", "外部核验记录字段无效。")
    }
    const view = await this.dependencies.results.get(identity, authorize, input.projectId, input.resultId, input.versionId)
    if (!isVerificationResultKind(view.kind) || view.kind !== "bid-verification") throw new BusinessError("NOT_FOUND", "找不到该核验成果。")
    if (view.sha256 !== input.sha256) throw new BusinessError("CONFLICT", "成果版本已变化，请重新读取后保存。")
    const embedded = embeddedVerificationValue(view.value)
    if (!embedded || !embedded.requirementIds.has(requirementId)) {
      throw new BusinessError("INVALID_INPUT", "核验记录的要求不在该成果版本中。")
    }
    await this.assertRetention(input.projectId)
    const proofVersion = await this.dependencies.materials.versionById(input.projectId, proofMaterialVersionId)
    if (!proofVersion) throw new BusinessError("INVALID_INPUT", "证明材料版本不属于当前项目。")
    const proofMaterial = await this.dependencies.materials.findMaterial(input.projectId, proofVersion.materialId)
    if (!proofMaterial || proofMaterial.status !== "active" || !proofMaterial.processingAuthorized) {
      throw new BusinessError("INVALID_INPUT", "证明材料版本不可用。")
    }
    if (retentionExpired(proofMaterial.retentionUntil, this.now())) throw new BusinessError("INVALID_SOURCE", "证明材料已超过保留期限。")
    const row = await this.dependencies.records.insert({
      projectId: input.projectId,
      requirementSetVersionId: embedded.requirementSetVersionId,
      requirementId,
      subject,
      certificateNo,
      source,
      queriedAt,
      queryConditions,
      conclusion: conclusion as VerificationExternalRecordView["conclusion"],
      proofMaterialVersionId,
      createdBy: identity.account.id,
    })
    return externalRecordView(row)
  }

  private async staleFor(view: ResultView, currentFields: VerificationFieldValue[], currentRecords: VerificationRecordRow[]): Promise<VerificationStaleState> {
    if (view.kind !== "bid-verification") return { records: false, fields: false, hint: null }
    const embedded = embeddedVerificationValue(view.value)
    if (!embedded) return { records: false, fields: false, hint: null }
    const recordsStale = recordListDigest(currentRecords.map(row => ({ recordId: row.recordId, sha256: row.sha256 }))) !==
      recordListDigest(embedded.embeddedRecords)
    const materials = new Set(embedded.materialVersionIds)
    const current = currentFields
      .filter(value => materials.has(value.versionId) && embedded.fieldKeys.has(value.fieldKey))
      .map(value => ({
        fieldKey: value.fieldKey, subjectKey: value.subjectKey, valueText: value.valueText,
        origin: value.origin, confidence: value.confidence, materialVersionId: value.versionId,
      }))
    const fieldsStale = evidenceDigest(current) !== evidenceDigest(embedded.embeddedEvidence)
    return { records: recordsStale, fields: fieldsStale, hint: recordsStale || fieldsStale ? STALE_HINT : null }
  }

  async list(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string): Promise<VerificationListSummary[]> {
    const views = (await this.dependencies.results.list(identity, authorize, projectId)).filter(view => isVerificationResultKind(view.kind))
    const materialVersionIds = new Set<string>()
    for (const view of views) {
      if (view.kind !== "bid-verification") continue
      const embedded = embeddedVerificationValue(view.value)
      for (const versionId of embedded?.materialVersionIds ?? []) materialVersionIds.add(versionId)
    }
    const currentFields = materialVersionIds.size ? await this.dependencies.fieldSource.values(projectId, [...materialVersionIds]) : []
    const summaries: VerificationListSummary[] = []
    for (const view of views) {
      const embedded = embeddedVerificationValue(view.value)
      let records: VerificationRecordRow[] = []
      if (view.kind === "bid-verification" && embedded) records = await this.dependencies.records.listBySetVersion(projectId, embedded.requirementSetVersionId)
      const stale = await this.staleFor(view, currentFields, records)
      summaries.push(this.summary(view, stale))
    }
    return summaries
  }

  async get(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, resultId: string): Promise<VerificationDetail> {
    const view = await this.dependencies.results.get(identity, authorize, projectId, resultId)
    if (!isVerificationResultKind(view.kind)) throw new BusinessError("NOT_FOUND", "找不到该核验成果。")
    const embedded = embeddedVerificationValue(view.value)
    const records = view.kind === "bid-verification" && embedded
      ? await this.dependencies.records.listBySetVersion(projectId, embedded.requirementSetVersionId)
      : []
    const currentFields = view.kind === "bid-verification" && embedded?.materialVersionIds.length
      ? await this.dependencies.fieldSource.values(projectId, embedded.materialVersionIds)
      : []
    const stale = await this.staleFor(view, currentFields, records)
    return { result: view, records: records.map(externalRecordView), stale }
  }

  private summary(view: ResultView, stale: VerificationStaleState): VerificationListSummary {
    const embedded = embeddedVerificationValue(view.value)
    const requirementSet = view.kind === "bid-requirements" ? inspectRequirementSet(view.value) : null
    const requirements = requirementSet?.value?.requirements
    const coverage = view.kind === "bid-verification"
      ? (view.value as { coverage?: Record<string, number> } | null)?.coverage : undefined
    const unfinishedCount = view.kind === "bid-verification"
      ? ((view.value as { unfinished?: unknown[] } | null)?.unfinished?.length ?? 0) : undefined
    const requirementCount = view.kind === "bid-requirements"
      ? (requirements?.length ?? 0)
      : (embedded?.requirementIds.size ?? 0)
    return {
      resultId: view.resultId,
      kind: view.kind as VerificationListSummary["kind"],
      versionId: view.versionId,
      sha256: view.sha256,
      createdAt: view.createdAt,
      createdBy: view.createdBy,
      origin: view.origin,
      validation: { status: view.validation.status, issues: view.validation.issues },
      review: view.review ? { decision: view.review.decision } : null,
      stale,
      summary: {
        ...(view.kind === "bid-requirements"
          ? { status: requirementSet?.value?.status }
          : { status: (view.value as { status?: "success" | "partial" } | null)?.status, asOf: (view.value as { asOf?: string } | null)?.asOf }),
        requirementCount,
        ...(coverage && Number.isSafeInteger(coverage.pending) ? { pendingCount: coverage.pending } : {}),
        ...(coverage && Number.isSafeInteger(coverage.materialSatisfied) ? { materialSatisfied: coverage.materialSatisfied } : {}),
        ...(coverage && Number.isSafeInteger(coverage.externalMatched) ? { externalMatched: coverage.externalMatched } : {}),
        ...(unfinishedCount !== undefined ? { unfinished: unfinishedCount } : {}),
      },
    }
  }
}
