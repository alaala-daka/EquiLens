import "server-only"
import { applicationDatabase } from "../database/runtime"
import { registerKnowledgePublicationRuntime } from "./registration"
import { KnowledgeRepository } from "./repository"

/**
 * C6 explicit Node lifecycle entry.
 *
 * `src/instrumentation.ts` must call `startKnowledgeRuntime()` before
 * `startTaskRunner()` (and before HTTP task submission is served) so the
 * task-submission publication resolver is registered. Importing this module
 * starts nothing: it only imports the server-only database runtime; the
 * resolver re-reads the database on each submission.
 *
 * A missing resolver is fail-closed: `TaskService.submitTask` rejects task
 * submission with HTTP 503 instead of silently running without a published
 * basis, so a database that already has publication history can never silently
 * downgrade to the debug review path.
 */
export function startKnowledgeRuntime(): void {
  registerKnowledgePublicationRuntime(async () => new KnowledgeRepository(await applicationDatabase()))
}
