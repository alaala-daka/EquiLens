import { createHash, randomUUID } from "node:crypto"
import type { Database } from "@/server/database/connection"
import { LedgerError, type LedgerInput, type PaymentLedgerRevision } from "@/lib/payments/types"
import { calculateLedger, validateLedger } from "./validation"

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const blank = (value: PaymentLedgerRevision) => ({ ...value, sha256: "" })
const schema = [
  `CREATE TABLE IF NOT EXISTS equilens_payment_ledger_revisions (
    id VARCHAR(36) PRIMARY KEY,
    ledger_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    contract_id VARCHAR(64),
    version INTEGER NOT NULL,
    base_revision_id VARCHAR(36),
    cutoff VARCHAR(10) NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(ledger_id, version)
  )`,
  "CREATE INDEX IF NOT EXISTS equilens_payment_ledger_project ON equilens_payment_ledger_revisions(project_id, contract_id, ledger_id, version)",
] as const

export class PaymentLedgerRepository {
  constructor(private readonly database: Database) {}
  async initialize() { await this.database.transaction(async c => { for (const statement of schema) await c.query(statement) }) }
  private async rows(sql: string, parameters: (string | number | null)[] = []) { return (await this.database.transaction(c => c.query(sql, parameters))).rows }
  async save(projectId: string, input: LedgerInput): Promise<PaymentLedgerRevision> {
    validateLedger({ ...input, projectId })
    return this.database.transaction(async c => {
      const ledgerId = input.ledgerId ?? randomUUID()
      const latestRow = (await c.query("SELECT payload FROM equilens_payment_ledger_revisions WHERE project_id=$1 AND ledger_id=$2 ORDER BY version DESC LIMIT 1", [projectId, ledgerId])).rows[0]
      if (input.ledgerId && !latestRow) throw new LedgerError("LEDGER_NOT_FOUND", "找不到要更正的款项表。")
      const prior = latestRow ? parse<PaymentLedgerRevision>(latestRow.payload) : null
      if (prior && input.baseRevisionId !== prior.ledgerRevisionId) throw new LedgerError("LEDGER_BASE_STALE", "款项表已有新版本，请重新载入。")
      const calculated = calculateLedger(input.rows, input.cutoff)
      const value: PaymentLedgerRevision = { ...input, projectId, ledgerId, ledgerRevisionId: randomUUID(), version: (prior?.version ?? 0) + 1,
        baseRevisionId: prior?.ledgerRevisionId, calculation: calculated.calculation, notes: calculated.notes, sha256: "", createdAt: new Date().toISOString() }
      value.sha256 = hash(blank(value))
      await c.query("INSERT INTO equilens_payment_ledger_revisions(id,ledger_id,project_id,contract_id,version,base_revision_id,cutoff,sha256,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [value.ledgerRevisionId, ledgerId, projectId, value.contractId ?? null, value.version, value.baseRevisionId ?? null, value.cutoff, value.sha256, JSON.stringify(value), value.createdAt])
      return value
    })
  }
  async revision(projectId: string, ledgerRevisionId: string): Promise<PaymentLedgerRevision> {
    const row = (await this.rows("SELECT payload FROM equilens_payment_ledger_revisions WHERE project_id=$1 AND id=$2", [projectId, ledgerRevisionId]))[0]
    if (!row) throw new LedgerError("LEDGER_NOT_FOUND", "找不到款项表版本。")
    const value = parse<PaymentLedgerRevision>(row.payload)
    if (value.sha256 !== hash(blank(value))) throw new LedgerError("LEDGER_INTEGRITY_FAILED", "款项表摘要不匹配。")
    return value
  }
  async latest(projectId: string, ledgerId: string): Promise<PaymentLedgerRevision | null> {
    const row = (await this.rows("SELECT payload FROM equilens_payment_ledger_revisions WHERE project_id=$1 AND ledger_id=$2 ORDER BY version DESC LIMIT 1", [projectId, ledgerId]))[0]
    return row ? parse<PaymentLedgerRevision>(row.payload) : null
  }
  async listLatest(projectId: string, contractId?: string): Promise<PaymentLedgerRevision[]> {
    const rows = contractId
      ? await this.rows("SELECT payload FROM equilens_payment_ledger_revisions p WHERE project_id=$1 AND contract_id=$2 AND version=(SELECT MAX(version) FROM equilens_payment_ledger_revisions x WHERE x.project_id=p.project_id AND x.ledger_id=p.ledger_id)", [projectId, contractId])
      : await this.rows("SELECT payload FROM equilens_payment_ledger_revisions p WHERE project_id=$1 AND version=(SELECT MAX(version) FROM equilens_payment_ledger_revisions x WHERE x.project_id=p.project_id AND x.ledger_id=p.ledger_id)", [projectId])
    return rows.map(row => parse<PaymentLedgerRevision>(row.payload))
  }
}
