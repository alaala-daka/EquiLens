import type { TaskKind } from "./catalog"

/**
 * Kind-level task admission hooks (round-four C4).
 *
 * Admission runs after authentication/authorization and request parsing but
 * before a task is persisted, so a kind whose current capability is not verified
 * (for example an OCR adapter without tested certificate kinds) is rejected with
 * 503/422 and never enters the queue. The registry is process-global like the
 * executor registry: instrumentation registers hooks explicitly, modules never
 * register on import, and tests may register a hook for a kind they own.
 */
export type TaskAdmissionInput = {
  kind: TaskKind
  projectId: string
  refs: Record<string, unknown>
  conditions: Record<string, unknown>
}

export type TaskAdmission = (input: TaskAdmissionInput) => Promise<void>

const runtime = globalThis as typeof globalThis & { equilensTaskAdmissions?: Map<TaskKind, TaskAdmission> }
const admissions = runtime.equilensTaskAdmissions ??= new Map<TaskKind, TaskAdmission>()

export function registerTaskAdmission(kind: TaskKind, admission: TaskAdmission): void {
  admissions.set(kind, admission)
}

export function taskAdmission(kind: TaskKind): TaskAdmission | null {
  return admissions.get(kind) ?? null
}
