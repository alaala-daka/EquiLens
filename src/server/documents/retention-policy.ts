import type { AnonymousSessionView, RetentionConsent } from "../../lib/documents/session-types"

export type StoredAnonymousSession = {
  owner: string
  contextId: string
  firstCreatedAt: string | null
  retentionDays: number | null
  expiresAt: string | null
  policyVersion: string | null
  exportUntil: string | null
  legacyPending: boolean
  revision: number
  revokedAt: string | null
  registration: string | null
}

export type RetentionPolicy = { days: number; version: string }

const dayMilliseconds = 86_400_000

function validDays(days: number) {
  return days > 0 && Number.isSafeInteger(days) && Number.isSafeInteger(days * dayMilliseconds)
}

export function retentionPolicy(env: Record<string, string | undefined> = process.env): RetentionPolicy {
  const raw = env.ANONYMOUS_DATA_RETENTION_DAYS
  if (!raw || !/^[1-9]\d*$/.test(raw) || !validDays(Number(raw))) {
    throw new Error("Invalid anonymous retention configuration")
  }
  const days = Number(raw)
  return { days, version: `anonymous-v1:${days}` }
}

export function retentionExpiry(firstCreatedAt: string, days: number): string {
  if (!validDays(days)) throw new Error("Invalid anonymous retention deadline")
  const date = new Date(Date.parse(firstCreatedAt) + days * dayMilliseconds)
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid anonymous retention deadline")
  return date.toISOString()
}

function shanghaiDate(instant: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(instant))
}

export function sessionAccess(
  record: StoredAnonymousSession,
  now: Date,
  currentPolicy: RetentionPolicy | null,
): AnonymousSessionView {
  const timestamp = now.getTime()
  if (!Number.isFinite(timestamp)) throw new Error("Invalid anonymous retention time")
  const expired = record.expiresAt !== null && Date.parse(record.expiresAt) <= timestamp
  const state: AnonymousSessionView["state"] = record.revokedAt !== null ? "expired"
    : record.legacyPending ? "legacy_pending"
    : expired ? record.exportUntil !== null && Date.parse(record.exportUntil) > timestamp ? "legacy_export" : "expired"
    : record.firstCreatedAt === null ? "new" : "active"
  const writable = state === "new" || state === "active"
  let confirmation: RetentionConsent | null = null
  if (writable) {
    if (state === "active" && record.expiresAt && record.policyVersion) {
      confirmation = { contextId: record.contextId, policyVersion: record.policyVersion, expiresOn: shanghaiDate(record.expiresAt) }
    } else if (state === "new" && currentPolicy) {
      confirmation = { contextId: record.contextId, policyVersion: currentPolicy.version, expiresOn: shanghaiDate(retentionExpiry(now.toISOString(), currentPolicy.days)) }
    }
  }
  const issue: AnonymousSessionView["issue"] = state === "expired"
    ? { code: "RETENTION_EXPIRED", message: "资料保留期限已到期" }
    : state === "legacy_pending" ? { code: "LEGACY_RETENTION_PENDING", message: "资料保留期限待登记" }
    : state === "legacy_export" ? { code: "RETENTION_READ_ONLY", message: "资料仅供读取和导出" }
    : !currentPolicy ? { code: "RETENTION_UNCONFIGURED", message: "资料保留期限配置不可用" } : undefined
  return {
    contextId: record.contextId, state, expiresAt: record.expiresAt, exportUntil: record.exportUntil,
    canRead: writable || state === "legacy_export", canCreate: writable && currentPolicy !== null,
    canSave: writable, canRestart: state === "expired" && currentPolicy !== null,
    confirmation, ...(issue ? { issue } : {}),
  }
}
