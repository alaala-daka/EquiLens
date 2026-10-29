import { registerPublicationResolver } from "../tasks/publications"
import { createPublicationResolver } from "./resolver"
import type { KnowledgeRepository } from "./repository"

/**
 * Testable registration seam for the C6 publication resolver.
 *
 * `runtime.ts` calls this exactly once from `startKnowledgeRuntime()` in the
 * explicit Node lifecycle; importing this module starts nothing. The repository
 * provider is invoked per task submission, so no database read happens during
 * registration.
 *
 * A missing resolver is fail-closed: `TaskService.submitTask` rejects task
 * submission with HTTP 503 instead of silently running without a published
 * basis, so a database that already has publication history can never silently
 * downgrade to the debug review path.
 */
const state = globalThis as typeof globalThis & { equilensKnowledgeRuntimeStarted?: boolean }

export function registerKnowledgePublicationRuntime(provider: () => Promise<KnowledgeRepository>): void {
  if (state.equilensKnowledgeRuntimeStarted) return
  state.equilensKnowledgeRuntimeStarted = true
  registerPublicationResolver(createPublicationResolver(provider))
}

export function knowledgeRuntimeStarted(): boolean {
  return state.equilensKnowledgeRuntimeStarted === true
}
