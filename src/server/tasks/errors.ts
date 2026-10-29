import type { BusinessErrorCode } from "../../lib/business/contracts"

/**
 * Task-domain errors shared by the generic task repository, the fixed task
 * catalogue and thin HTTP adapters. Business classes use C0 BusinessErrorCode;
 * INVALID_SUBMISSION is the task-admission validation class (HTTP 422) emitted
 * before a task is persisted.
 */
export type TaskErrorCode = BusinessErrorCode | "INVALID_SUBMISSION"

class TaskErrorConstructor extends Error {
  constructor(
    public readonly status: number,
    public readonly code: TaskErrorCode,
    message: string,
  ) { super(message) }
}

// Next instrumentation and routes may evaluate separate bundles. Consumers must
// recognise errors across bundles, so share the constructor through the global
// registry pattern used by the document store.
const constructorsKey = Symbol.for("equilens.task-error-constructors.v1")
const globalErrors = globalThis as typeof globalThis & {
  [constructorsKey]?: { TaskError: typeof TaskErrorConstructor }
}
const constructors = globalErrors[constructorsKey] ??= { TaskError: TaskErrorConstructor }
export const TaskError = constructors.TaskError
export type TaskError = InstanceType<typeof TaskErrorConstructor>

export function isTaskError(value: unknown): value is TaskError {
  return value instanceof TaskError
}
