export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startAuthRuntime } = await import("./server/auth/runtime")
    startAuthRuntime()
    const { startRetentionRuntime } = await import("./server/documents/retention-cleanup")
    // Data readiness belongs to document requests; health and server startup remain available on failure.
    startRetentionRuntime()
    const { startMaterialRuntime } = await import("./server/materials/runtime")
    startMaterialRuntime()
    // Register the project review executor before the task runner can claim a task.
    const { startReviewRuntime } = await import("./server/reviews/runtime")
    startReviewRuntime()
    // C4: certificate OCR capability + admission, then the deterministic bid executors.
    const { startOcrRuntime } = await import("./server/verification/ocr-runtime")
    startOcrRuntime()
    const { startVerificationRuntime } = await import("./server/verification/runtime")
    startVerificationRuntime()
    // C6: register the publication resolver before any task can be submitted/claimed.
    const { startKnowledgeRuntime } = await import("./server/knowledge/runtime")
    startKnowledgeRuntime()
    const { startTaskRunner } = await import("./server/tasks/runner")
    startTaskRunner()
  }
}
