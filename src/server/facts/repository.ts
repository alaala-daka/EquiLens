import { createHash, randomUUID } from "node:crypto"
import type { Database, Row } from "@/server/database/connection"
import { migrateBusiness } from "@/server/database/migrations"
import { FactError, type FactInput, type FactVersion } from "@/lib/facts/types"
import { canonicalJson } from "@/server/results/validation"
import { validateFact } from "./validation"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const conflict = () => new FactError("FACT_CONFLICT", "事实版本已变化，请重新读取后保存。")
function read(row: Row): FactVersion {
  const value = JSON.parse(String(row.payload)) as FactVersion
  if (value.sha256 !== hash({ ...value, sha256: "" }) || row.sha256 !== value.sha256 ||
    row.project_id !== value.projectId || row.id !== value.factVersionId || row.fact_id !== value.factId)
    throw new FactError("FACT_INTEGRITY_FAILED", "事实版本摘要不匹配。")
  return value
}

export class FactRepository {
  constructor(private readonly database: Database) {}
  /** Compatibility for legacy tests; production uses the migration lifecycle. */
  async initialize() { await migrateBusiness(this.database) }
  private async rows(sql: string, parameters: (string | number | null)[] = []) {
    return (await this.database.transaction(c => c.query(sql, parameters))).rows
  }
  async save(projectId: string, input: FactInput & { factId?: string; baseVersionId?: string }, options?: { operationId?: string; requestHash?: string }): Promise<FactVersion> {
    validateFact({ ...input, projectId })
    const factVersionId = randomUUID()
    const operationId = options?.operationId ?? `legacy:${factVersionId}`
    const requestHash = options?.requestHash ?? createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify({ ...input, projectId })))).digest("hex")
    try {
      return await this.database.transaction(async c => {
        const duplicate = (await c.query("SELECT * FROM equilens_fact_versions WHERE project_id=$1 AND operation_id=$2", [projectId, operationId])).rows[0]
        if (duplicate) { if (duplicate.request_hash !== requestHash) throw conflict(); return read(duplicate) }
        const factId = input.factId ?? randomUUID()
        const row = (await c.query("SELECT * FROM equilens_fact_versions WHERE project_id=$1 AND fact_id=$2 ORDER BY version DESC LIMIT 1", [projectId, factId])).rows[0]
        if (input.factId && !row) throw new FactError("FACT_NOT_FOUND", "找不到要更正的事实。")
        const prior = row ? read(row) : null
        if (input.baseVersionId !== undefined && input.baseVersionId !== (prior?.factVersionId ?? "")) throw conflict()
        if (prior) {
          const guarded = await c.query("UPDATE equilens_fact_versions SET payload=payload WHERE project_id=$1 AND id=$2 AND version=(SELECT MAX(version) FROM equilens_fact_versions WHERE project_id=$3 AND fact_id=$4)", [projectId, prior.factVersionId, projectId, factId])
          if (guarded.changes !== 1) throw conflict()
        }
        const { baseVersionId: _base, factId: _id, ...fields } = input
        void _base; void _id
        const value: FactVersion = { ...fields, projectId, factId, factVersionId, version: (prior?.version ?? 0) + 1,
          ...(prior ? { supersedesVersionId: prior.factVersionId } : {}), sha256: "", createdAt: new Date().toISOString(),
          evidenceStatus: input.conflicts.length ? "材料冲突" : input.support }
        value.sha256 = hash(value)
        await c.query("INSERT INTO equilens_fact_versions(id,fact_id,project_id,contract_id,version,supersedes_version_id,operation_id,request_hash,sha256,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [factVersionId, factId, projectId, value.contractId ?? null, value.version, value.supersedesVersionId ?? null, operationId, requestHash, value.sha256, JSON.stringify(value), value.createdAt])
        return value
      })
    } catch (failure) {
      const code = (failure as { code?: string }).code
      if (code !== "23505" && code !== "SQLITE_CONSTRAINT_UNIQUE" && !(code === "ERR_SQLITE_ERROR" && (failure as { errcode?: number }).errcode === 2067)) throw failure
      const row = (await this.rows("SELECT * FROM equilens_fact_versions WHERE project_id=$1 AND operation_id=$2", [projectId, operationId]))[0]
      if (row && row.request_hash === requestHash) return read(row)
      throw conflict()
    }
  }
  async version(projectId: string, factVersionId: string): Promise<FactVersion> {
    const row = (await this.rows("SELECT * FROM equilens_fact_versions WHERE project_id=$1 AND id=$2", [projectId, factVersionId]))[0]
    if (!row) throw new FactError("FACT_NOT_FOUND", "找不到事实版本。")
    return read(row)
  }
  async latest(projectId: string, factId: string): Promise<FactVersion | null> {
    const row = (await this.rows("SELECT * FROM equilens_fact_versions WHERE project_id=$1 AND fact_id=$2 ORDER BY version DESC LIMIT 1", [projectId, factId]))[0]
    return row ? read(row) : null
  }
  async history(projectId: string, factId: string): Promise<FactVersion[]> {
    const rows = await this.rows("SELECT * FROM equilens_fact_versions WHERE project_id=$1 AND fact_id=$2 ORDER BY version DESC", [projectId, factId])
    if (!rows.length) throw new FactError("FACT_NOT_FOUND", "找不到事实版本。")
    return rows.map(read)
  }
  async listLatest(projectId: string, contractId?: string): Promise<FactVersion[]> {
    const rows = await this.rows("SELECT * FROM equilens_fact_versions f WHERE project_id=$1 AND version=(SELECT MAX(version) FROM equilens_fact_versions x WHERE x.project_id=f.project_id AND x.fact_id=f.fact_id) ORDER BY fact_id", [projectId])
    return rows.map(read).filter(value => contractId === undefined || value.contractId === contractId)
      .sort((a, b) => a.field.localeCompare(b.field) || a.factId.localeCompare(b.factId))
  }
}
