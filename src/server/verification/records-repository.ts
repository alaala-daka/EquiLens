import { randomUUID } from "node:crypto"
import type { Database, Row } from "../database/connection"
import type { ExternalRecordConclusion } from "../../lib/business/verification-types"
import { recordSha256, type RecordDigestInput } from "./types"

/**
 * Append-only manual external-verification record store (migration 0010).
 *
 * Records are evidence: they are only ever inserted or read. The digest pins the
 * evidence content so a task manifest can reference `{recordId, sha256}`, and
 * re-reading proves the comparison used exactly those records — a later append
 * can never silently change a submitted or finished comparison. Writers check
 * project scope, the requirement-set version and requirement membership before
 * inserting; duplicate identical evidence is idempotent instead of duplicated.
 */
export type VerificationRecordRow = {
  recordId: string
  projectId: string
  requirementSetVersionId: string
  requirementId: string
  subject: string
  certificateNo: string
  source: string
  queriedAt: string
  queryConditions: string
  conclusion: ExternalRecordConclusion
  proofMaterialVersionId: string
  sha256: string
  createdBy: string
  createdAt: string
}

export type NewVerificationRecord = Omit<VerificationRecordRow, "recordId" | "sha256" | "createdAt">

const conclusions: readonly ExternalRecordConclusion[] = ["matched", "conflict", "not_found", "query_failed", "pending"]

function stored(row: Row): VerificationRecordRow {
  const conclusion = String(row.conclusion)
  if (!(conclusions as readonly string[]).includes(conclusion)) throw new Error("Invalid stored verification conclusion")
  return {
    recordId: String(row.id),
    projectId: String(row.project_id),
    requirementSetVersionId: String(row.requirement_set_version_id),
    requirementId: String(row.requirement_id),
    subject: String(row.subject),
    certificateNo: String(row.certificate_no),
    source: String(row.source),
    queriedAt: String(row.queried_at),
    queryConditions: String(row.query_conditions_json),
    conclusion: conclusion as ExternalRecordConclusion,
    proofMaterialVersionId: String(row.proof_material_version_id),
    sha256: String(row.sha256),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  }
}

export class VerificationRecordRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  private digestInput(input: NewVerificationRecord): RecordDigestInput {
    return {
      requirementSetVersionId: input.requirementSetVersionId,
      requirementId: input.requirementId,
      subject: input.subject,
      certificateNo: input.certificateNo,
      source: input.source,
      queriedAt: input.queriedAt,
      queryConditions: input.queryConditions,
      conclusion: input.conclusion,
      proofMaterialVersionId: input.proofMaterialVersionId,
    }
  }

  /** Insert evidence once; identical evidence for the same requirement returns the stored row. */
  async insert(input: NewVerificationRecord): Promise<VerificationRecordRow> {
    if (!(conclusions as readonly string[]).includes(input.conclusion)) throw new Error("Invalid verification conclusion")
    if (!input.projectId || !input.requirementSetVersionId || !input.requirementId) throw new Error("Invalid verification record scope")
    const sha256 = recordSha256(this.digestInput(input))
    return this.database.transaction(async connection => {
      const duplicate = (await connection.query(
        "SELECT * FROM equilens_verification_records WHERE project_id=$1 AND requirement_set_version_id=$2 AND requirement_id=$3 AND sha256=$4 LIMIT 1",
        [input.projectId, input.requirementSetVersionId, input.requirementId, sha256],
      )).rows[0]
      if (duplicate) return stored(duplicate)
      const row: VerificationRecordRow = {
        ...input,
        recordId: this.createId(),
        sha256,
        createdAt: this.now().toISOString(),
      }
      await connection.query(
        "INSERT INTO equilens_verification_records(id,project_id,requirement_set_version_id,requirement_id,subject,certificate_no,source,queried_at,query_conditions_json,conclusion,proof_material_version_id,sha256,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [row.recordId, row.projectId, row.requirementSetVersionId, row.requirementId, row.subject, row.certificateNo,
          row.source, row.queriedAt, row.queryConditions, row.conclusion, row.proofMaterialVersionId, row.sha256,
          row.createdBy, row.createdAt],
      )
      return row
    })
  }

  async findById(projectId: string, recordId: string): Promise<VerificationRecordRow | null> {
    const row = (await this.database.transaction(connection =>
      connection.query("SELECT * FROM equilens_verification_records WHERE project_id=$1 AND id=$2", [projectId, recordId]))).rows[0]
    return row ? stored(row) : null
  }

  /** All current evidence for one requirement-set version (append order); used by the detail hint. */
  async listBySetVersion(projectId: string, requirementSetVersionId: string): Promise<VerificationRecordRow[]> {
    const rows = (await this.database.transaction(connection =>
      connection.query(
        "SELECT * FROM equilens_verification_records WHERE project_id=$1 AND requirement_set_version_id=$2 ORDER BY created_at, id",
        [projectId, requirementSetVersionId],
      ))).rows
    return rows.map(stored)
  }
}
