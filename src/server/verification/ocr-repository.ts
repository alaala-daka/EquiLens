import { createHash, randomUUID } from "node:crypto"
import type { ProjectAccess, ProjectAction } from "../../lib/business/contracts"
import {
  VERIFICATION_FIELD_LABELS, VERIFICATION_FIELD_TYPES, isVerificationFieldKey, normalizeFieldValue, quotesMatch,
  type VerificationFieldKey,
} from "../../lib/business/verification-fields"
import type { AuthIdentity } from "../auth/service"
import type { Database, Connection, Row } from "../database/connection"
import type { MaterialRepository } from "../materials/repository"
import { BusinessError } from "../projects/errors"
import { retentionExpired } from "../reviews/input"
import type { FieldSource, VerificationFieldOrigin, VerificationFieldValue } from "./field-source"

/**
 * C4-OCR persistence seam (migration 0010 tables owned by src/server/verification/schema.ts).
 *
 * Two responsibilities live here:
 *  1. `OcrRepository` — insert-only OCR runs and verification-field history. It is
 *     also the production `FieldSource` consumed by C4-VERIFY: only the current
 *     (`superseded_at IS NULL`) value of every (material version, subject, field) is
 *     returned, sorted by (subjectKey, fieldKey). No module may read these tables
 *     outside this repository.
 *  2. `VerificationFieldService` — the authorized manual field path used by the
 *     fields HTTP route. A manual value is only recorded as material-supported
 *     (`origin = "material_text"`) when it cites a fragment of the *same material
 *     version* whose text contains the value verbatim (`quotesMatch`, spec 01 §7.2).
 *     Otherwise it is stored as a pending human entry (`origin = "manual"`, no
 *     fragment) and must never be presented as OCR output or a verified fact.
 *
 * The field table has no status column: the difference between "supported by the
 * material text" and "pending" is expressed by the presence/absence of the
 * verified same-version fragment plus the explicit origin. Values are insert-only
 * history: a write inserts a new row (`previous_id`, `revision + 1`) and then
 * conditionally supersedes the previous current row in the same transaction, so
 * concurrent writers can never leave two current values and old values stay
 * auditable (spec 01 §6.1/§8.3).
 */

const runStates = ["running", "succeeded", "partial", "failed", "unavailable"] as const
export type OcrRunState = (typeof runStates)[number]

const origins: readonly VerificationFieldOrigin[] = ["ocr", "manual", "material_text"]

export type OcrRunRecord = {
  id: string
  projectId: string
  materialId: string
  versionId: string
  certificateKind: string
  state: OcrRunState
  provider: string | null
  providerVersion: string | null
  requestId: string | null
  callsUsed: number
  usageJson: string | null
  imageJson: string | null
  errorCode: string | null
  createdBy: string
  startedAt: string
  finishedAt: string | null
}

export type VerificationFieldRecord = {
  id: string
  projectId: string
  materialId: string
  versionId: string
  subjectKey: string
  fieldKey: VerificationFieldKey
  label: string
  /** Raw value as recognized or entered; never rewritten by a correction. */
  valueText: string
  /** Shared-vocabulary normalization of `valueText`; empty string when it cannot be normalized. */
  normalizedValue: string
  origin: VerificationFieldOrigin
  sourceSnapshotId: string | null
  sourceFragmentId: string | null
  ocrRunId: string | null
  confidence: number | null
  boxJson: string | null
  revision: number
  previousId: string | null
  supersededAt: string | null
  reason: string | null
  createdBy: string
  createdAt: string
}

/** One insert-only field write. Normalization is always derived here, never supplied by callers. */
export type FieldWrite = {
  projectId: string
  materialId: string
  versionId: string
  subjectKey: string
  fieldKey: VerificationFieldKey
  valueText: string
  origin: VerificationFieldOrigin
  sourceSnapshotId?: string | null
  sourceFragmentId?: string | null
  ocrRunId?: string | null
  confidence?: number | null
  boxJson?: string | null
  reason?: string | null
  createdBy: string
  /** Retry-stable identity: the same key never inserts a second row. */
  idempotencyKey: string
}

export type NewOcrRun = {
  id?: string
  projectId: string
  materialId: string
  versionId: string
  certificateKind: string
  createdBy: string
  startedAt?: string
  callsUsed?: number
  requestId?: string | null
}

export type FinishedOcrRun = {
  projectId: string
  id: string
  state: Exclude<OcrRunState, "running">
  callsUsed: number
  provider?: string | null
  providerVersion?: string | null
  requestId?: string | null
  usageJson?: string | null
  imageJson?: string | null
  errorCode?: string | null
  finishedAt?: string
}

const sha = (...parts: readonly string[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex")

/** Stable UUID-shaped id derived from a retry-stable key (no new persistence needed). */
export function fieldIdFor(key: string): string {
  const hex = sha("verification-field", key).slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function runRecord(row: Row): OcrRunRecord {
  if (typeof row.state !== "string" || !runStates.includes(row.state as OcrRunState)) throw new Error("Invalid stored OCR run state")
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    materialId: String(row.material_id),
    versionId: String(row.version_id),
    certificateKind: String(row.certificate_kind),
    state: row.state as OcrRunState,
    provider: row.provider === null || row.provider === undefined ? null : String(row.provider),
    providerVersion: row.provider_version === null || row.provider_version === undefined ? null : String(row.provider_version),
    requestId: row.request_id === null || row.request_id === undefined ? null : String(row.request_id),
    callsUsed: Number(row.calls_used),
    usageJson: row.usage_json === null || row.usage_json === undefined ? null : String(row.usage_json),
    imageJson: row.image_json === null || row.image_json === undefined ? null : String(row.image_json),
    errorCode: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
    createdBy: String(row.created_by),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
  }
}

function fieldRecord(row: Row): VerificationFieldRecord {
  const origin = row.origin
  if (typeof origin !== "string" || !origins.includes(origin as VerificationFieldOrigin)) throw new Error("Invalid stored verification field origin")
  const fieldKey = String(row.field_key)
  if (!isVerificationFieldKey(fieldKey)) throw new Error("Invalid stored verification field key")
  const confidence = row.confidence === null || row.confidence === undefined ? null : Number(row.confidence)
  if (confidence !== null && (!Number.isInteger(confidence) || confidence < 0 || confidence > 100)) throw new Error("Invalid stored verification confidence")
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    materialId: String(row.material_id),
    versionId: String(row.version_id),
    subjectKey: String(row.subject_key),
    fieldKey,
    label: String(row.label),
    valueText: String(row.value_text),
    normalizedValue: String(row.normalized_value),
    origin: origin as VerificationFieldOrigin,
    sourceSnapshotId: row.source_snapshot_id === null || row.source_snapshot_id === undefined ? null : String(row.source_snapshot_id),
    sourceFragmentId: row.source_fragment_id === null || row.source_fragment_id === undefined ? null : String(row.source_fragment_id),
    ocrRunId: row.ocr_run_id === null || row.ocr_run_id === undefined ? null : String(row.ocr_run_id),
    confidence,
    boxJson: row.box_json === null || row.box_json === undefined ? null : String(row.box_json),
    revision: Number(row.revision),
    previousId: row.previous_id === null || row.previous_id === undefined ? null : String(row.previous_id),
    supersededAt: row.superseded_at === null || row.superseded_at === undefined ? null : String(row.superseded_at),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  }
}

function currentValue(record: VerificationFieldRecord): VerificationFieldValue {
  return {
    materialId: record.materialId,
    versionId: record.versionId,
    subjectKey: record.subjectKey,
    fieldKey: record.fieldKey,
    label: record.label,
    valueText: record.valueText,
    normalizedValue: record.normalizedValue,
    origin: record.origin,
    sourceSnapshotId: record.sourceSnapshotId,
    sourceFragmentId: record.sourceFragmentId,
    ocrRunId: record.ocrRunId,
    confidence: record.confidence,
    revision: record.revision,
    updatedAt: record.createdAt,
  }
}

function assertFieldWrite(input: FieldWrite): void {
  if (!isVerificationFieldKey(input.fieldKey)) throw new BusinessError("INVALID_INPUT", "字段不在证照字段词表内。")
  if (!origins.includes(input.origin)) throw new BusinessError("INVALID_INPUT", "字段来源无效。")
  if (!input.subjectKey.trim() || input.subjectKey.length > 64) throw new BusinessError("INVALID_INPUT", "字段主体标识无效。")
  if (typeof input.valueText !== "string" || !input.valueText.trim() || input.valueText.length > 2000) throw new BusinessError("INVALID_INPUT", "字段值无效。")
  if (!input.idempotencyKey.trim()) throw new BusinessError("INVALID_INPUT", "字段写入标识无效。")
  if (input.confidence !== null && input.confidence !== undefined && (!Number.isInteger(input.confidence) || input.confidence < 0 || input.confidence > 100)) throw new BusinessError("INVALID_INPUT", "字段置信度无效。")
  if (input.reason !== null && input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 500)) throw new BusinessError("INVALID_INPUT", "更正理由无效。")
}

function assertFinishedOcrRun(input: FinishedOcrRun): void {
  if (!runStates.includes(input.state)) throw new BusinessError("INVALID_INPUT", "OCR 运行状态无效。")
  if (!Number.isInteger(input.callsUsed) || input.callsUsed < 0) throw new BusinessError("INVALID_INPUT", "OCR 调用次数无效。")
}

/**
 * Insert-only OCR run and verification-field storage, plus the frozen FieldSource
 * read seam. Every method is project-scoped: a row from another project is
 * indistinguishable from a missing row.
 */
export class OcrRepository implements FieldSource {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  // ---------------------------------------------------------------- OCR runs

  async beginRun(input: NewOcrRun): Promise<OcrRunRecord> {
    const startedAt = input.startedAt ?? this.now().toISOString()
    const record: OcrRunRecord = {
      id: input.id ?? this.createId(),
      projectId: input.projectId,
      materialId: input.materialId,
      versionId: input.versionId,
      certificateKind: input.certificateKind,
      state: "running",
      provider: null,
      providerVersion: null,
      requestId: input.requestId ?? null,
      callsUsed: input.callsUsed ?? 0,
      usageJson: null,
      imageJson: null,
      errorCode: null,
      createdBy: input.createdBy,
      startedAt,
      finishedAt: null,
    }
    await this.database.transaction(connection => connection.query(
      "INSERT INTO equilens_ocr_runs(id,project_id,material_id,version_id,certificate_kind,state,provider,provider_version,request_id,calls_used,usage_json,image_json,error_code,created_by,started_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
      [record.id, record.projectId, record.materialId, record.versionId, record.certificateKind, record.state, null, null, record.requestId, record.callsUsed, null, null, null, record.createdBy, record.startedAt, null],
    ))
    return record
  }

  /** Conditional transition running -> terminal; exactly one affected row or the write is rejected. */
  async finishRun(input: FinishedOcrRun): Promise<void> {
    assertFinishedOcrRun(input)
    await this.database.transaction(connection => this.finishRunOn(connection, input))
  }

  /**
   * Atomic success/partial path: append the recognized fields AND finish the run
   * in one transaction, so a crash can never leave fields attached to a run that
   * is still "running" (or a finished run with missing fields).
   */
  async completeRun(input: FinishedOcrRun & { fields?: readonly FieldWrite[] }): Promise<VerificationFieldRecord[]> {
    assertFinishedOcrRun(input)
    const fields = input.fields ?? []
    for (const field of fields) assertFieldWrite(field)
    return this.database.transaction(async connection => {
      const written = fields.length ? await this.insertFieldsOn(connection, fields) : []
      await this.finishRunOn(connection, input)
      return written
    })
  }

  private async finishRunOn(connection: Connection, input: FinishedOcrRun): Promise<void> {
    const finishedAt = input.finishedAt ?? this.now().toISOString()
    const updated = await connection.query(
      "UPDATE equilens_ocr_runs SET state=$1,provider=$2,provider_version=$3,request_id=COALESCE($4,request_id),calls_used=$5,usage_json=$6,image_json=$7,error_code=$8,finished_at=$9 WHERE id=$10 AND project_id=$11 AND state='running'",
      [input.state, input.provider ?? null, input.providerVersion ?? null, input.requestId ?? null, input.callsUsed, input.usageJson ?? null, input.imageJson ?? null, input.errorCode ?? null, finishedAt, input.id, input.projectId],
    )
    if (updated.changes !== 1) throw new BusinessError("CONFLICT", "OCR 运行状态已变化。")
  }

  async findRun(projectId: string, runId: string): Promise<OcrRunRecord | null> {
    const { rows } = await this.database.transaction(connection => connection.query(
      "SELECT * FROM equilens_ocr_runs WHERE project_id=$1 AND id=$2", [projectId, runId],
    ))
    return rows.length ? runRecord(rows[0]) : null
  }

  async runs(projectId: string, materialId: string): Promise<OcrRunRecord[]> {
    const { rows } = await this.database.transaction(connection => connection.query(
      "SELECT * FROM equilens_ocr_runs WHERE project_id=$1 AND material_id=$2 ORDER BY started_at, id", [projectId, materialId],
    ))
    return rows.map(runRecord)
  }

  // ------------------------------------------------------------ field history

  /**
   * Insert a batch of field values as one insert-only history step. For every
   * (project, version, subject, field) the previous current row is superseded by
   * a conditional update that must affect exactly one row; any deviation rolls
   * the whole batch back so at most one current value ever remains.
   */
  async insertFields(inputs: readonly FieldWrite[]): Promise<VerificationFieldRecord[]> {
    if (!inputs.length) return []
    for (const input of inputs) assertFieldWrite(input)
    return this.database.transaction(connection => this.insertFieldsOn(connection, inputs))
  }

  private async insertFieldsOn(connection: Connection, inputs: readonly FieldWrite[]): Promise<VerificationFieldRecord[]> {
    const written: VerificationFieldRecord[] = []
    for (const input of inputs) {
      const id = fieldIdFor(`${input.projectId}\u0000${input.versionId}\u0000${input.subjectKey}\u0000${input.fieldKey}\u0000${input.idempotencyKey}`)
      const existing = await connection.query("SELECT * FROM equilens_verification_fields WHERE project_id=$1 AND version_id=$2 AND id=$3", [input.projectId, input.versionId, id])
      if (existing.rows.length) {
        // Retried write: the first attempt already appended this exact row.
        written.push(fieldRecord(existing.rows[0]))
        continue
      }
      const current = await connection.query(
        "SELECT id,revision FROM equilens_verification_fields WHERE project_id=$1 AND version_id=$2 AND subject_key=$3 AND field_key=$4 AND superseded_at IS NULL ORDER BY revision DESC",
        [input.projectId, input.versionId, input.subjectKey, input.fieldKey],
      )
      if (current.rows.length > 1) throw new BusinessError("CONFLICT", "字段当前值不唯一。")
      const previous = current.rows[0]
      const revision = previous ? Number(previous.revision) + 1 : 1
      const createdAt = this.now().toISOString()
      const normalizedValue = normalizeFieldValue(input.fieldKey, input.valueText)
      await connection.query(
        "INSERT INTO equilens_verification_fields(id,project_id,material_id,version_id,subject_key,field_key,label,value_text,normalized_value,origin,source_snapshot_id,source_fragment_id,ocr_run_id,confidence,box_json,revision,previous_id,superseded_at,reason,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NULL,$18,$19,$20)",
        [id, input.projectId, input.materialId, input.versionId, input.subjectKey, input.fieldKey, VERIFICATION_FIELD_LABELS[input.fieldKey], input.valueText, normalizedValue, input.origin, input.sourceSnapshotId ?? null, input.sourceFragmentId ?? null, input.ocrRunId ?? null, input.confidence ?? null, input.boxJson ?? null, revision, previous ? String(previous.id) : null, input.reason ?? null, input.createdBy, createdAt],
      )
      if (previous) {
        const superseded = await connection.query(
          "UPDATE equilens_verification_fields SET superseded_at=$1 WHERE project_id=$2 AND id=$3 AND superseded_at IS NULL",
          [createdAt, input.projectId, String(previous.id)],
        )
        if (superseded.changes !== 1) throw new BusinessError("CONFLICT", "字段当前值已变化，请重新读取后重试。")
      }
      // In-transaction invariant: exactly one current row for this key. A
      // violation rolls the whole batch back instead of leaving ambiguous values.
      const invariant = await connection.query(
        "SELECT COUNT(*) AS current_count FROM equilens_verification_fields WHERE project_id=$1 AND version_id=$2 AND subject_key=$3 AND field_key=$4 AND superseded_at IS NULL",
        [input.projectId, input.versionId, input.subjectKey, input.fieldKey],
      )
      if (Number(invariant.rows[0]?.current_count) !== 1) throw new BusinessError("CONFLICT", "字段当前值不唯一。")
      const inserted = await connection.query("SELECT * FROM equilens_verification_fields WHERE project_id=$1 AND id=$2", [input.projectId, id])
      if (inserted.rows.length !== 1) throw new BusinessError("CONFLICT", "字段写入失败。")
      written.push(fieldRecord(inserted.rows[0]))
    }
    return written
  }

  /** Current (non-superseded) values for one material version, ordered by subject/field. */
  async currentFields(projectId: string, versionId: string): Promise<VerificationFieldRecord[]> {
    const { rows } = await this.database.transaction(connection => connection.query(
      "SELECT * FROM equilens_verification_fields WHERE project_id=$1 AND version_id=$2 AND superseded_at IS NULL ORDER BY subject_key, field_key, revision", [projectId, versionId],
    ))
    return rows.map(fieldRecord)
  }

  /** Full insert-only history (current and superseded), newest revisions first per field. */
  async fieldHistory(projectId: string, versionId: string): Promise<VerificationFieldRecord[]> {
    const { rows } = await this.database.transaction(connection => connection.query(
      "SELECT * FROM equilens_verification_fields WHERE project_id=$1 AND version_id=$2 ORDER BY subject_key, field_key, revision DESC", [projectId, versionId],
    ))
    return rows.map(fieldRecord)
  }

  /**
   * Frozen FieldSource implementation: current values only, for the given
   * material versions of one project, sorted by (subjectKey, fieldKey).
   */
  async values(projectId: string, materialVersionIds: readonly string[]): Promise<VerificationFieldValue[]> {
    const ids = [...new Set(materialVersionIds.filter(id => typeof id === "string" && id))]
    if (!ids.length) return []
    const placeholders = ids.map((_, index) => `$${index + 2}`).join(",")
    const { rows } = await this.database.transaction(connection => connection.query(
      `SELECT * FROM equilens_verification_fields WHERE project_id=$1 AND superseded_at IS NULL AND version_id IN (${placeholders}) ORDER BY subject_key, field_key, revision`,
      [projectId, ...ids],
    ))
    return rows.map(row => currentValue(fieldRecord(row)))
  }
}

// ---------------------------------------------------------------------------
// Authorized manual field path (HTTP route: …/versions/[versionId]/fields)
// ---------------------------------------------------------------------------

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const operationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/
const subjectPattern = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * Field view returned by the fields route. `support` is derived, never supplied
 * by the browser: `ocr` = recognized original, `material_text` = the value was
 * verified verbatim against a same-version fragment, `pending` = human entry
 * that is not yet supported by the material text (待确认).
 */
export type VerificationFieldView = {
  id: string
  materialId: string
  versionId: string
  subjectKey: string
  fieldKey: VerificationFieldKey
  label: string
  valueText: string
  normalizedValue: string
  origin: VerificationFieldOrigin
  support: "ocr" | "material_text" | "pending"
  sourceSnapshotId: string | null
  sourceFragmentId: string | null
  ocrRunId: string | null
  confidence: number | null
  revision: number
  previousId: string | null
  supersededAt: string | null
  reason: string | null
  createdBy: string
  createdAt: string
}

export type FieldRef = { projectId: string; materialId: string; versionId: string }

export type ManualFieldInput = {
  fieldKey: VerificationFieldKey
  valueText: string
  subjectKey?: string
  sourceFragmentId?: string | null
}

export type ManualFieldBody = {
  operationId: string
  reason?: string | null
  fields: ManualFieldInput[]
}

export type VerificationFieldServiceDependencies = {
  repository: OcrRepository
  materials: Pick<MaterialRepository, "findMaterial" | "findVersion" | "findFragmentForVersion">
  requireProjectAccess: (identity: AuthIdentity, projectId: string, action: ProjectAction) => Promise<ProjectAccess>
  /** Trusted server resolver; null means the project is missing or no longer active. */
  readProjectRetention: (projectId: string) => Promise<string | null>
  now?: () => Date
}

function fieldView(record: VerificationFieldRecord): VerificationFieldView {
  const support: VerificationFieldView["support"] = record.origin === "ocr"
    ? "ocr"
    : record.sourceFragmentId ? "material_text" : "pending"
  return {
    id: record.id, materialId: record.materialId, versionId: record.versionId, subjectKey: record.subjectKey,
    fieldKey: record.fieldKey, label: record.label, valueText: record.valueText, normalizedValue: record.normalizedValue,
    origin: record.origin, support, sourceSnapshotId: record.sourceSnapshotId, sourceFragmentId: record.sourceFragmentId,
    ocrRunId: record.ocrRunId, confidence: record.confidence, revision: record.revision, previousId: record.previousId,
    supersededAt: record.supersededAt, reason: record.reason, createdBy: record.createdBy, createdAt: record.createdAt,
  }
}

function invalid(message: string): BusinessError {
  return new BusinessError("INVALID_INPUT", message)
}

function manualFieldBody(value: unknown): ManualFieldBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("字段登记信息不完整或格式无效。")
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !["operationId", "reason", "fields"].includes(key))) throw invalid("字段登记信息包含无效内容。")
  if (typeof input.operationId !== "string" || !operationPattern.test(input.operationId)) throw invalid("字段登记操作标识无效。")
  let reason: string | null = null
  if (input.reason !== undefined && input.reason !== null) {
    if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.trim().length > 500) throw invalid("更正理由无效。")
    reason = input.reason.trim()
  }
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 50) throw invalid("字段列表无效。")
  const seen = new Set<string>()
  const fields = input.fields.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("字段内容无效。")
    const field = raw as Record<string, unknown>
    if (Object.keys(field).some(key => !["fieldKey", "valueText", "subjectKey", "sourceFragmentId"].includes(key))) throw invalid("字段内容包含无效键。")
    if (!isVerificationFieldKey(field.fieldKey)) throw invalid("字段不在证照字段词表内。")
    if (typeof field.valueText !== "string" || !field.valueText.trim() || field.valueText.trim().length > 2000) throw invalid("字段值无效。")
    const subjectKey = field.subjectKey === undefined ? "enterprise" : field.subjectKey
    if (typeof subjectKey !== "string" || !subjectPattern.test(subjectKey)) throw invalid("字段主体标识无效。")
    let sourceFragmentId: string | null = null
    if (field.sourceFragmentId !== undefined && field.sourceFragmentId !== null) {
      if (typeof field.sourceFragmentId !== "string" || !uuidPattern.test(field.sourceFragmentId)) throw invalid("来源片段标识无效。")
      sourceFragmentId = field.sourceFragmentId
    }
    const key = `${subjectKey}\u0000${field.fieldKey}`
    if (seen.has(key)) throw invalid("同一字段不能在一次登记中重复。")
    seen.add(key)
    return { fieldKey: field.fieldKey, valueText: field.valueText.trim(), subjectKey, sourceFragmentId } satisfies ManualFieldInput
  })
  return { operationId: input.operationId, reason, fields }
}

/**
 * Authorized read/registration of certificate fields for one exact material version.
 *
 * Writes are insert-only: a correction NEVER overwrites the original; the previous
 * current row is superseded in the same transaction and the new row keeps
 * `previous_id`/`revision + 1`. A manual value counts as material-supported only
 * when it cites a fragment of this very version whose text contains the value
 * verbatim (whitespace may be normalized); otherwise it is stored as pending and
 * must not be used as OCR output or as a verified certificate fact.
 */
export class VerificationFieldService {
  constructor(private readonly dependencies: VerificationFieldServiceDependencies) {}

  async list(identity: AuthIdentity, ref: FieldRef): Promise<{ fields: VerificationFieldView[]; history: VerificationFieldView[] }> {
    const target = await this.target(identity, ref, "read")
    const all = await this.dependencies.repository.fieldHistory(target.projectId, target.versionId)
    return {
      fields: all.filter(record => record.supersededAt === null).map(fieldView),
      history: all.filter(record => record.supersededAt !== null).map(fieldView),
    }
  }

  async register(identity: AuthIdentity, ref: FieldRef, value: unknown): Promise<{ fields: VerificationFieldView[] }> {
    const body = manualFieldBody(value)
    const target = await this.target(identity, ref, "edit")
    const writes: FieldWrite[] = []
    for (const field of body.fields) {
      let sourceSnapshotId: string | null = null
      let sourceFragmentId: string | null = null
      if (field.sourceFragmentId) {
        const fragment = await this.dependencies.materials.findFragmentForVersion(target.projectId, target.versionId, field.sourceFragmentId)
        if (!fragment) throw invalid("来源片段不属于该材料版本。")
        if (!quotesMatch(fragment.text, field.valueText)) throw invalid("登记值未能在该材料版本原文中逐字核对。")
        sourceSnapshotId = fragment.snapshotId
        sourceFragmentId = fragment.id
      }
      const normalizedValue = normalizeFieldValue(field.fieldKey, field.valueText)
      const type = VERIFICATION_FIELD_TYPES[field.fieldKey]
      if ((type === "date" || type === "identifier") && !normalizedValue) throw invalid(type === "date" ? "日期字段需填写可识别的日期。" : "标识字段值无效。")
      writes.push({
        projectId: target.projectId, materialId: target.materialId, versionId: target.versionId,
        subjectKey: field.subjectKey ?? "enterprise", fieldKey: field.fieldKey, valueText: field.valueText,
        origin: sourceFragmentId ? "material_text" : "manual",
        sourceSnapshotId, sourceFragmentId, ocrRunId: null, confidence: null, boxJson: null,
        reason: body.reason, createdBy: identity.account.id,
        idempotencyKey: `manual:${body.operationId}`,
      })
    }
    // A human field write is a material-derived write: re-read project edit
    // access, material activity/processing authorization and both retention
    // clocks immediately before INSERT/UPDATE so an expired or revoked input can
    // never gain a new field-history row.
    await this.revalidateWrite(identity, target)
    await this.dependencies.repository.insertFields(writes)
    const current = await this.dependencies.repository.currentFields(target.projectId, target.versionId)
    const wanted = new Set(writes.map(write => `${write.subjectKey}\u0000${write.fieldKey}`))
    return { fields: current.filter(record => wanted.has(`${record.subjectKey}\u0000${record.fieldKey}`)).map(fieldView) }
  }

  /** Fresh pre-write authorization plus material/retention gates. */
  private async revalidateWrite(identity: AuthIdentity, target: { projectId: string; materialId: string; versionId: string }): Promise<void> {
    await this.dependencies.requireProjectAccess(identity, target.projectId, "edit")
    const material = await this.dependencies.materials.findMaterial(target.projectId, target.materialId)
    if (!material || material.status !== "active") throw new BusinessError("NOT_FOUND", "找不到该材料。")
    if (!material.processingAuthorized) throw new BusinessError("INVALID_SOURCE", "材料未授权处理，不能登记字段。")
    const current = this.dependencies.now?.() ?? new Date()
    const projectRetention = await this.dependencies.readProjectRetention(target.projectId)
    if (!projectRetention) throw new BusinessError("NOT_FOUND", "找不到该项目。")
    if (retentionExpired(projectRetention, current)) throw new BusinessError("INVALID_SOURCE", "项目保留期已到期，不能登记字段。")
    if (retentionExpired(material.retentionUntil, current)) throw new BusinessError("INVALID_SOURCE", "材料保留期已到期，不能登记字段。")
  }

  /** Project-scoped material version lookup: anything from another project is a 404. */
  private async target(identity: AuthIdentity, ref: FieldRef, action: ProjectAction): Promise<{ projectId: string; materialId: string; versionId: string }> {
    if (!ref || typeof ref.projectId !== "string" || !uuidPattern.test(ref.projectId) ||
      typeof ref.materialId !== "string" || !uuidPattern.test(ref.materialId) ||
      typeof ref.versionId !== "string" || !uuidPattern.test(ref.versionId)) throw invalid("材料版本标识无效。")
    await this.dependencies.requireProjectAccess(identity, ref.projectId, action)
    const material = await this.dependencies.materials.findMaterial(ref.projectId, ref.materialId)
    if (!material || material.status !== "active") throw new BusinessError("NOT_FOUND", "找不到该材料。")
    const version = await this.dependencies.materials.findVersion(ref.projectId, ref.materialId, ref.versionId)
    if (!version) throw new BusinessError("NOT_FOUND", "找不到该材料版本。")
    return { projectId: ref.projectId, materialId: ref.materialId, versionId: ref.versionId }
  }
}
