import type { TaskKind } from "./catalog"
import type { TaskExecutor } from "./runner-core"
// Instrumentation and route bundles must resolve the same process registry.
const runtime = globalThis as typeof globalThis & { equilensTaskExecutors?: Map<TaskKind, TaskExecutor> }
const executors = runtime.equilensTaskExecutors ??= new Map<TaskKind, TaskExecutor>()
export function registerTaskExecutor(kind: TaskKind, executor: TaskExecutor): void { executors.set(kind, executor) }
export const taskExecutorRegistry = {
  get: (kind: TaskKind): TaskExecutor | null => executors.get(kind) ?? null,
  available: (): TaskKind[] => [...executors.keys()],
}
