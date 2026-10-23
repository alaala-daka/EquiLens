export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return
  const { startRetentionRuntime } = await import("./server/documents/retention-cleanup")
  // Data readiness belongs to document requests; health and server startup remain available on failure.
  startRetentionRuntime()
  const { startReviewRunner } = await import("./server/contract-review/tasks/runner")
  startReviewRunner()
}
