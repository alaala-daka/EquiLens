import { createHash, randomUUID } from "node:crypto"
import type { Database } from "@/server/database/connection"
import { FactError, type FactInput, type FactVersion } from "@/lib/facts/types"
import { validateFact } from "./validation"

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const blank = (value: FactVersion) => ({ ...value, sha256: "" })

const schema = [
  `CREATE TABLE IF NOT EXISTS equilens_fact_versions (
    id VARCHAR(36) PRIMARY KEY,
    fact_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    contract_id VARCHAR(64),
    version INTEGER NOT NULL,
    supersedes_version_id VARCHAR(36),
    sha256 VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(fact_id, version)
  )`,
  "CREATE INDEX IF NOT EXISTS equilens_fact_version_project ON equilens_fact_versions(project_id, contract_id, fact_id, version)",
] as const

export class FactRepository {
  constructor(private readonly database: Database) {}
  async initialize() { await this.database.transaction(async c => { for (const statement of schema) await c.query(statement) }) }
  private async rows(sql: string, parameters: (string | number | null)[] = []) {
    return (await this.database.transaction(c => c.query(sql, parameters))).rows
  }
  async save(projectId: string, input: FactInput & { factId?: string }): Promise<FactVersion> {
    validateFact({ ...input, projectId })
    return this.database.transaction(async c => {
      const factId = input.factId ?? randomUUID()
      const latest = (await c.query("SELECT payload FROM equilens_fact_versions WHERE project_id=$1 AND fact_id=$2 ORDER BY version DESC LIMIT 1", [projectId, factId])).rows[0]
      if (input.factId && !latest) throw new FactError("FACT_NOT_FOUND", "找不到要更正的事实。")
      const prior = latest ? parse<FactVersion>(latest.payload) : null
      const value: FactVersion = { ...input, factId, factVersionId: randomUUID(), version: (prior?.version ?? 0) + 1,
        ...(prior ? { supersedesVersionId: prior.factVersionId } : {}), sha256: "", createdAt: new Date().toISOString(),
        evidenceStatus: input.conflicts.length ? "材料冲突" : input.support }
      value.sha256 = hash(blank(value))
      await c.query("INSERT INTO equilens_fact_versions(id,fact_id,project_id,contract_id,version,supersedes_version_id,sha256,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [value.factVersionId, factId, projectId, value.contractId ?? null, value.version, value.supersedesVersionId ?? null, value.sha256, JSON.stringify(value), value.createdAt])
      return value
    })
  }
  async version(projectId: string, factVersionId: string): Promise<FactVersion> {
    const row = (await this.rows("SELECT payload FROM equilens_fact_versions WHERE project_id=$1 AND id=$2", [projectId, factVersionId]))[0]
    if (!row) throw new FactError("FACT_NOT_FOUND", "找不到事实版本。")
    const value = parse<FactVersion>(row.payload)
    if (value.sha256 !== hash(blank(value))) throw new FactError("FACT_INTEGRITY_FAILED", "事实版本摘要不匹配。")
    return value
  }
  async latest(projectId: string, factId: string): Promise<FactVersion | null> {
    const row = (await this.rows("SELECT payload FROM equilens_fact_versions WHERE project_id=$1 AND fact_id=$2 ORDER BY version DESC LIMIT 1", [projectId, factId]))[0]
    return row ? parse<FactVersion>(row.payload) : null
  }
  async listLatest(projectId: string, contractId?: string): Promise<FactVersion[]> {
    const rows = contractId
      ? await this.rows("SELECT payload FROM equilens_fact_versions f WHERE project_id=$1 AND contract_id=$2 AND version=(SELECT MAX(version) FROM equilens_fact_versions x WHERE x.project_id=f.project_id AND x.fact_id=f.fact_id) ORDER BY fact_id", [projectId, contractId])
      : await this.rows("SELECT payload FROM equilens_fact_versions f WHERE project_id=$1 AND version=(SELECT MAX(version) FROM equilens_fact_versions x WHERE x.project_id=f.project_id AND x.fact_id=f.fact_id) ORDER BY fact_id", [projectId])
    return rows.map(row => parse<FactVersion>(row.payload))
  }
}
