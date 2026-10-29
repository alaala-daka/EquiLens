import {
  DocumentSessionError, RevisionConflict, createDocument, openDocument as openAnonymousDocument,
  preflightEditorAccess, saveDocument,
} from "./client"
import type { EditorDependencies } from "./editor-session"
import type { RetentionConsent } from "./session-types"
import { documentTitle, downloadName, errorMessage, type DocumentRecord, type OpenDocument } from "./types"

/**
 * Injectable editor access layer (A2).
 *
 * The editor controller only knows this interface. The anonymous adapter below
 * preserves the existing client behaviour (X-Document-Context checks,
 * operationId/baseRevision idempotency, DOCX bytes, session errors); C3 adds a
 * project adapter that maps membership failures into the same failure classes
 * without inventing a second editor controller.
 */

export type EditorAccessFailureCode =
  | "SESSION_INVALID"
  | "ACCESS_DENIED"
  | "CONFLICT"
  | "ABORTED"
  | "UNAVAILABLE"
  | "FAILED"

export type EditorAccessFailure = {
  code: EditorAccessFailureCode
  message: string
  retryable: boolean
  cause?: unknown
}

const retryableCodes: readonly EditorAccessFailureCode[] = ["UNAVAILABLE", "FAILED"]

/**
 * Provider-neutral editor failure. Project adapters throw this instead of
 * reusing the anonymous DocumentSessionError codes; the controller only reads
 * `code`, `message` and `retryable`.
 */
export class EditorAccessError extends Error {
  readonly code: EditorAccessFailureCode
  readonly retryable: boolean
  declare readonly cause?: unknown

  constructor(code: EditorAccessFailureCode, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message)
    this.name = "EditorAccessError"
    this.code = code
    this.retryable = options?.retryable ?? retryableCodes.includes(code)
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

// The anonymous retention/session codes that make further editing unsafe. Copy
// consent denials (RETENTION_UNCONFIGURED, *_CONSENT_REQUIRED,
// *_CONFIRMATION_CHANGED, SESSION_RESTART_NOT_ALLOWED) stay as ACCESS_DENIED so
// an existing document remains readable and savable.
const anonymousSessionInvalidCodes = [
  "RETENTION_EXPIRED", "SESSION_CHANGED", "SESSION_CONTEXT_REQUIRED",
  "RETENTION_READ_ONLY", "LEGACY_RETENTION_PENDING",
] as const

function sessionLost(session: { canRead?: boolean; canSave?: boolean } | undefined): boolean {
  return session?.canRead === false || session?.canSave === false
}

function describeAnonymousFailure(failure: DocumentSessionError): EditorAccessFailure {
  const invalid = sessionLost(failure.session)
    || (anonymousSessionInvalidCodes as readonly string[]).includes(failure.code)
  return {
    code: invalid ? "SESSION_INVALID" : "ACCESS_DENIED",
    message: failure.message,
    retryable: !invalid,
    cause: failure,
  }
}

function isAbort(failure: unknown): boolean {
  return typeof failure === "object" && failure !== null
    && (failure as { name?: unknown }).name === "AbortError"
}

/**
 * Default classification. It recognises the shared EditorAccessError marker
 * first, then the existing anonymous client errors so pre-A2 callers keep their
 * exact session/conflict semantics. Adapters may override it through
 * `describeFailure`.
 */
export function describeEditorFailure(failure: unknown): EditorAccessFailure {
  if (failure instanceof EditorAccessError) {
    return { code: failure.code, message: failure.message, retryable: failure.retryable, cause: failure }
  }
  if (failure instanceof RevisionConflict) {
    return { code: "CONFLICT", message: failure.message, retryable: false, cause: failure }
  }
  if (failure instanceof DocumentSessionError) return describeAnonymousFailure(failure)
  if (isAbort(failure)) {
    return { code: "ABORTED", message: errorMessage(failure), retryable: true, cause: failure }
  }
  return { code: "FAILED", message: errorMessage(failure), retryable: true, cause: failure }
}

export type EditorOpenOptions = { signal?: AbortSignal }
export type EditorPreflightOptions = { signal?: AbortSignal; copy?: boolean }

/** Same shape the editor controller sends today; bytes are the serialized DOCX. */
export type EditorSaveInput = {
  documentId: string
  baseRevision: string
  operationId: string
  title: string
  prompt: string
  blob: Blob
}

export type EditorCopyInput = {
  blob: Blob
  title: string
  source: DocumentRecord["source"]
  fileName?: string
  prompt?: string
  copiedFrom?: DocumentRecord["copiedFrom"]
  retentionConsent?: RetentionConsent
}

export type EditorAccess = {
  open(documentId: string, options?: EditorOpenOptions): Promise<OpenDocument>
  preflight(documentId: string, options: EditorPreflightOptions): Promise<void>
  save(input: EditorSaveInput, options?: { signal?: AbortSignal }): Promise<OpenDocument>
  copy(input: EditorCopyInput, options?: { signal?: AbortSignal }): Promise<OpenDocument>
  download(blob: Blob, title: string): void
  /** Optional override; defaults to describeEditorFailure. */
  describeFailure?(failure: unknown): EditorAccessFailure
  /** Optional notification when the controller decides the session is invalid. */
  notifySessionInvalid?(failure: unknown): void
}

/** Browser download used when no UI-owned downloader (object URL cleanup) is supplied. */
export function downloadDocument(blob: Blob, title: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("当前环境无法下载 Word 文档，请重试。")
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  try {
    link.href = url
    link.download = downloadName(title)
    document.body.append(link)
    link.click()
  } finally {
    link.remove()
    // Browsers need the object URL alive until the download starts.
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
}

export type AnonymousEditorAccessOptions = {
  /**
   * UI-owned downloader. DocumentEditor passes its bridge downloader so object
   * URLs are still revoked on unmount; other callers get the browser default.
   */
  download?: (blob: Blob, title: string) => void
  /** Receives the original anonymous DocumentSessionError, unchanged. */
  onSessionInvalid?: (failure: DocumentSessionError) => void
}

/**
 * Anonymous adapter: the current client functions behind the shared interface.
 * No operationId/baseRevision/byte transformation happens here, so existing
 * idempotency, conflict and export-byte behaviour is unchanged.
 */
export function createAnonymousEditorAccess(options: AnonymousEditorAccessOptions = {}): EditorAccess {
  return {
    open: (documentId, openOptions) => openAnonymousDocument(documentId, openOptions?.signal),
    preflight: (documentId, preflightOptions) => preflightEditorAccess(documentId, preflightOptions),
    save: (input, saveOptions) => saveDocument(input, saveOptions),
    copy: (input, copyOptions) => createDocument(
      input.blob,
      documentTitle(input.title),
      input.source,
      input.fileName,
      input.prompt ?? "",
      input.copiedFrom,
      { signal: copyOptions?.signal, retentionConsent: input.retentionConsent },
    ),
    download: options.download ?? downloadDocument,
    describeFailure: describeEditorFailure,
    notifySessionInvalid(failure) {
      if (failure instanceof DocumentSessionError) options.onSessionInvalid?.(failure)
    },
  }
}

/**
 * Adapt any EditorAccess to the controller dependency shape used by
 * createEditorSession. Kept separate so existing anonymous controller tests
 * continue to exercise the controller directly.
 */
export function createEditorSessionDependencies(options: {
  access: EditorAccess
  opened: OpenDocument
  serialize: () => Promise<Blob>
  onSaved: (saved: OpenDocument) => void
}): EditorDependencies {
  const { access, opened } = options
  return {
    opened,
    serialize: options.serialize,
    preflight: preflightOptions => access.preflight(opened.document.id, preflightOptions),
    save: (input, saveOptions) => access.save(input, saveOptions),
    copy: (blob, title, source, fileName, prompt = "", copiedFrom, copyOptions) => access.copy({
      blob, title, source, fileName, prompt, copiedFrom, retentionConsent: copyOptions?.retentionConsent,
    }, { signal: copyOptions?.signal }),
    download: (blob, title) => access.download(blob, title),
    onSaved: options.onSaved,
    onSessionUnavailable: failure => access.notifySessionInvalid?.(failure),
    describeFailure: failure => (access.describeFailure ?? describeEditorFailure)(failure),
  }
}
