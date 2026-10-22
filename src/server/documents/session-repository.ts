import { randomUUID } from "node:crypto"
import type { AnonymousSessionView, DocumentSessionCode, RetentionConsent } from "../../lib/documents/session-types"
import type { DocumentRecord } from "../../lib/documents/types"
import type { Connection, Database, Row } from "../database/connection"
import { SessionRegistrationRace, StoreError, sessionTransaction } from "./errors"
import { retentionExpiry, sessionAccess, type RetentionPolicy, type StoredAnonymousSession } from "./retention-policy"

export type SessionRepositoryOptions = { now: () => Date; readPolicy: () => RetentionPolicy | null }
export type LegacyRetentionRegistration = { owner: string; retentionDays: number; exportUntil: string; notifiedAt: string; operator: string; purpose: string }
type SessionAction = "read" | "download" | "save" | "create" | "copy"

const stored = (row: Row): StoredAnonymousSession => ({
  owner: String(row.owner), contextId: String(row.context_id), firstCreatedAt: row.first_created_at === null ? null : String(row.first_created_at),
  retentionDays: row.retention_days === null ? null : Number(row.retention_days), expiresAt: row.expires_at === null ? null : String(row.expires_at),
  policyVersion: row.policy_version === null ? null : String(row.policy_version), exportUntil: row.export_until === null ? null : String(row.export_until),
  legacyPending: Number(row.legacy_pending) === 1, revision: Number(row.revision), revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
  registration: row.registration === null ? null : String(row.registration),
})

function denied(status: number, code: DocumentSessionCode, view: AnonymousSessionView): never {
  const messages: Record<DocumentSessionCode, string> = {
    RETENTION_UNCONFIGURED: "资料保留期限配置不可用", RETENTION_EXPIRED: "资料保留期限已到期", LEGACY_RETENTION_PENDING: "资料保留期限待登记",
    SESSION_CONTEXT_REQUIRED: "缺少会话上下文", SESSION_CHANGED: "会话已变更，请重新载入", RETENTION_CONSENT_REQUIRED: "请确认资料保留期限",
    RETENTION_CONFIRMATION_CHANGED: "资料保留期限已变化，请重新确认", RETENTION_READ_ONLY: "资料仅供读取和导出", SESSION_RESTART_NOT_ALLOWED: "当前会话不能重新开始",
  }
  throw new StoreError(status, messages[code], code, view)
}

export class DocumentSessionRepository {
  constructor(private readonly database: Database, private readonly options: SessionRepositoryOptions) {}

  private async findIn(connection: Connection, owner: string) {
    const { rows } = await connection.query("SELECT * FROM equilens_document_sessions WHERE owner=$1", [owner])
    return rows.length ? stored(rows[0]) : null
  }

  private async earliestIn(connection: Connection, owner: string) {
    const { rows } = await connection.query("SELECT metadata FROM equilens_documents WHERE owner=$1", [owner])
    const dates = rows.map(row => String(JSON.parse(String(row.metadata)).createdAt))
    if (dates.some(date => !Number.isFinite(Date.parse(date)))) throw new Error("Invalid stored document creation time")
    return dates.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null
  }

  private async ensureIn(connection: Connection, owner: string, now: Date): Promise<StoredAnonymousSession> {
    const existing = await this.findIn(connection, owner)
    if (existing) return existing
    const firstCreatedAt = await this.earliestIn(connection, owner)
    const record: StoredAnonymousSession = { owner, contextId: randomUUID(), firstCreatedAt, retentionDays: null, expiresAt: null, policyVersion: null, exportUntil: null, legacyPending: firstCreatedAt !== null, revision: 0, revokedAt: null, registration: null }
    try {
      await connection.query("INSERT INTO equilens_document_sessions(owner,context_id,registered_at,first_created_at,retention_days,expires_at,policy_version,export_until,legacy_pending,revision,revoked_at,registration) VALUES ($1,$2,$3,$4,NULL,NULL,NULL,NULL,$5,0,NULL,NULL)", [owner, record.contextId, now.toISOString(), firstCreatedAt, record.legacyPending ? 1 : 0])
    } catch (failure) {
      const code = (failure as { code?: string }).code
      if (code === "23505" || code === "ERR_SQLITE_CONSTRAINT_PRIMARYKEY" || code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || (failure as { errcode?: number }).errcode === 1555) throw new SessionRegistrationRace()
      throw failure
    }
    return record
  }

  view(owner: string): Promise<AnonymousSessionView> {
    return sessionTransaction(this.database, async connection => {
      const now = this.options.now()
      return sessionAccess(await this.ensureIn(connection, owner, now), now, this.options.readPolicy())
    })
  }

  async assertContext(owner: string, contextId: string): Promise<void> {
    const view = await this.view(owner)
    if (!contextId) denied(400, "SESSION_CONTEXT_REQUIRED", view)
    if (view.contextId !== contextId) denied(409, "SESSION_CHANGED", view)
  }

  assertAccess(owner: string, action: SessionAction): Promise<void> {
    return sessionTransaction(this.database, async connection => { await this.guardIn(connection, owner, action) })
  }

  async guardIn(connection: Connection, owner: string, action: SessionAction): Promise<StoredAnonymousSession> {
    const now = this.options.now()
    const record = await this.ensureIn(connection, owner, now)
    const view = sessionAccess(record, now, this.options.readPolicy())
    if (view.state === "expired") denied(410, "RETENTION_EXPIRED", view)
    if (view.state === "legacy_pending") denied(503, "LEGACY_RETENTION_PENDING", view)
    if (view.state === "legacy_export" && action !== "read" && action !== "download") denied(403, "RETENTION_READ_ONLY", view)
    if ((action === "create" || action === "copy") && !view.canCreate) denied(503, "RETENTION_UNCONFIGURED", view)
    return record
  }

  async confirmCreateIn(connection: Connection, owner: string, source: DocumentRecord["source"], consent: RetentionConsent | undefined): Promise<{ createdAt: string; expiresAt: string }> {
    const now = this.options.now()
    let record = await this.ensureIn(connection, owner, now)
    const policy = this.options.readPolicy()
    let view = sessionAccess(record, now, policy)
    if (view.state === "expired") denied(410, "RETENTION_EXPIRED", view)
    if (view.state === "legacy_pending") denied(503, "LEGACY_RETENTION_PENDING", view)
    if (view.state === "legacy_export") denied(403, "RETENTION_READ_ONLY", view)
    if (!policy) denied(503, "RETENTION_UNCONFIGURED", view)
    if (source === "copy") {
      if (!record.firstCreatedAt || !record.expiresAt) denied(409, "RETENTION_CONFIRMATION_CHANGED", view)
      return { createdAt: now.toISOString(), expiresAt: record.expiresAt }
    }
    this.confirm(view, consent)
    if (!record.firstCreatedAt) {
      const createdAt = now.toISOString()
      const expiresAt = retentionExpiry(createdAt, policy.days)
      const result = await connection.query("UPDATE equilens_document_sessions SET first_created_at=$1,retention_days=$2,expires_at=$3,policy_version=$4,revision=revision+1 WHERE owner=$5 AND revision=$6 AND first_created_at IS NULL AND revoked_at IS NULL", [createdAt, policy.days, expiresAt, policy.version, owner, record.revision])
      if (result.changes === 1) return { createdAt, expiresAt }
      record = (await this.findIn(connection, owner))!
      if (!record) throw new Error("Anonymous session registration lost")
      view = sessionAccess(record, now, policy)
      if (view.state === "expired") denied(410, "RETENTION_EXPIRED", view)
      if (view.state === "legacy_pending") denied(503, "LEGACY_RETENTION_PENDING", view)
      if (view.state === "legacy_export") denied(403, "RETENTION_READ_ONLY", view)
      this.confirm(view, consent)
    }
    if (!record.expiresAt) throw new Error("Anonymous session deadline missing")
    return { createdAt: now.toISOString(), expiresAt: record.expiresAt }
  }

  private confirm(view: AnonymousSessionView, consent: RetentionConsent | undefined) {
    if (!consent) denied(422, "RETENTION_CONSENT_REQUIRED", view)
    const expected = view.confirmation
    if (!expected || expected.contextId !== consent.contextId || expected.policyVersion !== consent.policyVersion || expected.expiresOn !== consent.expiresOn) denied(409, "RETENTION_CONFIRMATION_CHANGED", view)
  }

  async registerLegacy(input: LegacyRetentionRegistration): Promise<void> {
    await this.registerLegacyBatch([input], true)
  }

  async registerLegacyBatch(inputs: LegacyRetentionRegistration[], apply: boolean): Promise<number> {
    return sessionTransaction(this.database, async connection => {
      const now = this.options.now()
      const plans = []
      const owners = new Set<string>()
      for (const input of inputs) {
        if (owners.has(input.owner)) throw new Error("Duplicate registration owner")
        owners.add(input.owner)
        const notified = Date.parse(input.notifiedAt)
        const until = Date.parse(input.exportUntil)
        if (!Number.isFinite(notified) || !Number.isFinite(until) || notified > now.getTime() || until <= notified || !input.operator.trim() || !input.purpose.trim()) throw new Error("Invalid legacy retention registration")
        const registration = JSON.stringify({ owner: input.owner, retentionDays: input.retentionDays, exportUntil: new Date(until).toISOString(), notifiedAt: new Date(notified).toISOString(), operator: input.operator, purpose: input.purpose })
        const firstCreatedAt = await this.earliestIn(connection, input.owner)
        if (!firstCreatedAt) throw new Error("Unknown legacy owner")
        const record = await this.findIn(connection, input.owner)
        if (record?.revokedAt) throw new Error("Legacy retention registration not allowed")
        const expiresAt = retentionExpiry(firstCreatedAt, input.retentionDays)
        if (record?.registration != null) {
          if (record.registration === registration) continue
          throw new StoreError(409, "存量资料保留登记已变化。")
        }
        if ((record && !record.legacyPending) || until <= now.getTime()) throw new Error("Legacy retention registration not allowed")
        plans.push({ input, expiresAt, registration, until })
      }
      if (apply) for (const { input, expiresAt, registration, until } of plans) {
        const record = await this.ensureIn(connection, input.owner, now)
        const result = await connection.query("UPDATE equilens_document_sessions SET retention_days=$1,expires_at=$2,policy_version=$3,export_until=$4,legacy_pending=0,registration=$5,revision=revision+1 WHERE owner=$6 AND revision=$7 AND legacy_pending=1 AND revoked_at IS NULL", [input.retentionDays, expiresAt, `anonymous-v1:${input.retentionDays}`, new Date(until).toISOString(), registration, input.owner, record.revision])
        if (result.changes !== 1) {
          const current = await this.findIn(connection, input.owner)
          if (current?.registration === registration && current.revokedAt === null) continue
          throw new StoreError(409, "存量资料保留登记已变化。")
        }
      }
      return inputs.length
    })
  }

  async expiredOwners(limit: number): Promise<StoredAnonymousSession[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid retention batch size")
    const now = this.options.now().toISOString()
    return this.database.transaction(async connection => {
      const { rows } = await connection.query("SELECT s.* FROM equilens_document_sessions s WHERE (revoked_at IS NOT NULL OR (legacy_pending=0 AND expires_at IS NOT NULL AND expires_at<=$1 AND (export_until IS NULL OR export_until<=$2))) AND (NOT EXISTS (SELECT 1 FROM equilens_retention_deletions x WHERE x.owner=s.owner AND x.completed_at IS NOT NULL) OR EXISTS (SELECT 1 FROM equilens_documents d WHERE d.owner=s.owner) OR EXISTS (SELECT 1 FROM equilens_revisions r WHERE r.owner=s.owner)) ORDER BY expires_at,owner LIMIT $3", [now, now, limit])
      return rows.map(stored)
    })
  }
}
