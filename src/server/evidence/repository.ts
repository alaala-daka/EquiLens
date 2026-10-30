import { createHash, randomUUID } from "node:crypto"
import type { Database } from "@/server/database/connection"
import { migrateBusiness } from "@/server/database/migrations"
import type { EvidenceItem, EvidenceItemInput, EvidenceReport } from "@/lib/evidence/types"
import { EvidenceError } from "@/lib/evidence/types"
import { evidenceReportSchema } from "./schema"

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const withoutSha = <T extends { sha256: string }>(value: T) => ({ ...value, sha256: "" })
const conflict = () => new EvidenceError("EVIDENCE_CONFLICT", "证据版本已变化，请重新读取后保存。")

function validItem(value: EvidenceItem) {
  if (value.sha256 !== digest(withoutSha(value))) throw new EvidenceError("EVIDENCE_INTEGRITY_FAILED", "证据版本摘要不匹配。")
  return value
}
function validReport(value: EvidenceReport) {
  if (value.sha256 !== digest(withoutSha(value))) throw new EvidenceError("EVIDENCE_INTEGRITY_FAILED", "报告版本摘要不匹配。")
  return value
}

export class EvidenceRepository {
  constructor(private readonly database: Database) {}

  /**
   * 显式初始化。证据项表由迁移 0015 建立；只有历史报告表仍是运行时表
   * （第八轮起报告走项目成果，旧表不再由主线写入）。
   */
  async initialize() {
    await migrateBusiness(this.database)
    await this.database.transaction(async connection => { for (const statement of evidenceReportSchema) await connection.query(statement) })
  }

  private async rows(sql: string, parameters: (string | number | null)[] = []) {
    return (await this.database.transaction(connection => connection.query(sql, parameters))).rows
  }

  /**
   * 保存不可变证据项版本。生产调用由项目证据服务显式传入 operationId/requestHash/baseVersionId；
   * 未提供时保留旧匿名语义（每次生成新版本，operationId 记为 legacy:<versionId>）。
   */
  async saveItem(input: EvidenceItemInput & { itemId?: string }, options?: { operationId?: string; requestHash?: string; baseVersionId?: string }): Promise<EvidenceItem> {
    const requestHash = options?.requestHash ?? digest(input)
    const itemId = input.itemId ?? randomUUID()
    const versionId = randomUUID()
    const operationId = options?.operationId ?? `legacy:${versionId}`
    try {
      return await this.database.transaction(async connection => {
        const duplicate = (await connection.query("SELECT payload, request_hash FROM equilens_evidence_items WHERE project_id=$1 AND operation_id=$2",
          [input.projectId, operationId])).rows[0]
        if (duplicate) {
          if (String(duplicate.request_hash) !== requestHash) throw conflict()
          return validItem(parse<EvidenceItem>(duplicate.payload))
        }
        const prior = (await connection.query("SELECT payload FROM equilens_evidence_items WHERE project_id=$1 AND item_id=$2 ORDER BY created_at DESC LIMIT 1",
          [input.projectId, itemId])).rows[0]
        const previous = prior ? validItem(parse<EvidenceItem>(prior.payload)) : null
        if (options?.baseVersionId !== undefined && options.baseVersionId !== (previous?.versionId ?? "")) throw conflict()
        const payload: EvidenceItem = { ...input, itemId, versionId, sha256: "", createdAt: new Date().toISOString() }
        if (previous) payload.supersedesVersionId = previous.versionId
        payload.sha256 = digest(withoutSha(payload))
        await connection.query("INSERT INTO equilens_evidence_items(id,item_id,version_id,project_id,contract_id,base_version_id,operation_id,request_hash,supersedes_version_id,sha256,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [randomUUID(), itemId, payload.versionId, payload.projectId, payload.contractId ?? null, previous?.versionId ?? null, operationId, requestHash,
            payload.supersedesVersionId ?? null, payload.sha256, JSON.stringify(payload), payload.createdAt])
        return payload
      })
    } catch (failure) {
      const code = (failure as { code?: string }).code
      if (code !== "23505" && code !== "SQLITE_CONSTRAINT_UNIQUE" && !(code === "ERR_SQLITE_ERROR" && (failure as { errcode?: number }).errcode === 2067)) throw failure
      const row = (await this.rows("SELECT payload, request_hash FROM equilens_evidence_items WHERE project_id=$1 AND operation_id=$2", [input.projectId, operationId]))[0]
      if (row && String(row.request_hash) === requestHash) return validItem(parse<EvidenceItem>(row.payload))
      throw conflict()
    }
  }

  async item(projectId: string, versionId: string): Promise<EvidenceItem> {
    const row = (await this.rows("SELECT payload FROM equilens_evidence_items WHERE project_id=$1 AND version_id=$2", [projectId, versionId]))[0]
    if (!row) throw new EvidenceError("EVIDENCE_NOT_FOUND", "找不到证据版本。")
    return validItem(parse<EvidenceItem>(row.payload))
  }

  async latestItem(projectId: string, itemId: string): Promise<EvidenceItem | null> {
    const row = (await this.rows("SELECT payload FROM equilens_evidence_items WHERE project_id=$1 AND item_id=$2 ORDER BY created_at DESC LIMIT 1", [projectId, itemId]))[0]
    return row ? validItem(parse<EvidenceItem>(row.payload)) : null
  }

  async latestItems(projectId: string, contractId?: string): Promise<EvidenceItem[]> {
    const rows = await this.rows("SELECT payload FROM equilens_evidence_items e WHERE project_id=$1 AND created_at=(SELECT MAX(created_at) FROM equilens_evidence_items x WHERE x.project_id=e.project_id AND x.item_id=e.item_id) ORDER BY created_at",
      [projectId])
    return rows.map(row => validItem(parse<EvidenceItem>(row.payload)))
      .filter(item => contractId === undefined || item.contractId === contractId)
  }

  async history(projectId: string, itemId: string): Promise<EvidenceItem[]> {
    const rows = await this.rows("SELECT payload FROM equilens_evidence_items WHERE project_id=$1 AND item_id=$2 ORDER BY created_at DESC", [projectId, itemId])
    if (!rows.length) throw new EvidenceError("EVIDENCE_NOT_FOUND", "找不到证据版本。")
    return rows.map(row => validItem(parse<EvidenceItem>(row.payload)))
  }

  /** 历史报告表（匿名增量/领域层）；项目主线的报告保存为 `evidence-report` 成果。 */
  async saveReport(input: Omit<EvidenceReport, "reportId" | "revisionId" | "sha256" | "createdAt"> & { reportId?: string }): Promise<EvidenceReport> {
    const report: EvidenceReport = { ...input, reportId: input.reportId ?? randomUUID(), revisionId: randomUUID(),
      sha256: "", createdAt: new Date().toISOString() }
    report.sha256 = digest(withoutSha(report))
    await this.database.transaction(async connection => {
      await connection.query("INSERT INTO equilens_evidence_reports(id,revision_id,report_id,project_id,contract_id,base_revision_id,status,review_status,sha256,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [randomUUID(), report.revisionId, report.reportId, report.projectId, report.contractId ?? null, report.baseRevisionId ?? null, report.status, report.reviewStatus, report.sha256, JSON.stringify(report), report.createdAt])
    })
    return report
  }

  async report(projectId: string, revisionId: string): Promise<EvidenceReport> {
    const row = (await this.rows("SELECT payload FROM equilens_evidence_reports WHERE project_id=$1 AND revision_id=$2", [projectId, revisionId]))[0]
    if (!row) throw new EvidenceError("EVIDENCE_NOT_FOUND", "找不到证据报告版本。")
    return validReport(parse<EvidenceReport>(row.payload))
  }

  async latestReport(projectId: string, contractId?: string): Promise<EvidenceReport | null> {
    const rows = contractId
      ? await this.rows("SELECT payload FROM equilens_evidence_reports WHERE project_id=$1 AND contract_id=$2 ORDER BY created_at DESC LIMIT 1", [projectId, contractId])
      : await this.rows("SELECT payload FROM equilens_evidence_reports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1", [projectId])
    return rows[0] ? validReport(parse<EvidenceReport>(rows[0].payload)) : null
  }
}
