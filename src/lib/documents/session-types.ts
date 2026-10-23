export type RetentionConsent = {
  contextId: string
  policyVersion: string
  expiresOn: string
}

export type DocumentSessionCode =
  | "RETENTION_UNCONFIGURED" | "RETENTION_EXPIRED" | "LEGACY_RETENTION_PENDING"
  | "SESSION_CONTEXT_REQUIRED" | "SESSION_CHANGED"
  | "RETENTION_CONSENT_REQUIRED" | "RETENTION_CONFIRMATION_CHANGED"
  | "RETENTION_READ_ONLY" | "SESSION_RESTART_NOT_ALLOWED"

export type AnonymousSessionView = {
  contextId: string
  state: "new" | "active" | "legacy_export" | "expired" | "legacy_pending"
  expiresAt: string | null
  exportUntil: string | null
  canRead: boolean
  canCreate: boolean
  canSave: boolean
  canRestart: boolean
  confirmation: RetentionConsent | null
  issue?: { code: DocumentSessionCode; message: string }
}
