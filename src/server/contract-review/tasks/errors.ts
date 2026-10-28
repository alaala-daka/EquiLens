export type RevisionDownloadCode = "REVISION_TASK_REQUIRED" | "REVISION_NOT_READY"

class RevisionDownloadErrorConstructor extends Error {
  readonly status = 409
  constructor(public readonly code: RevisionDownloadCode, message: string, public readonly revisionTaskId?: string) {
    super(message)
  }
}

// Node lifecycle services and route bundles must recognize the same error constructor.
const constructorsKey = Symbol.for("equilens.review-task-error-constructors.v1")
const globalErrors = globalThis as typeof globalThis & {
  [constructorsKey]?: { RevisionDownloadError: typeof RevisionDownloadErrorConstructor }
}
const constructors = globalErrors[constructorsKey] ??= { RevisionDownloadError: RevisionDownloadErrorConstructor }
export const RevisionDownloadError = constructors.RevisionDownloadError
