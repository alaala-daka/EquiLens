/**
 * Shared task admission and execution limits (spec/01-product.md §9/§10).
 * Values are the Demo configuration targets; changing them requires the same
 * evidence as any other capacity claim.
 */
export const taskLimits = {
  /** Global queued tasks (running tasks are limited separately by the single lease). */
  maxQueued: 10,
  /** Unfinished tasks (queued or running) per submitting account. */
  maxUnfinishedPerOwner: 2,
  /** Attempts include process recovery and explicit retries. */
  maxAttempts: 3,
  /** Single task cumulative execution budget. */
  maxElapsedMs: 600000,
  /** Execution lease and heartbeat cadence. */
  leaseMs: 60000,
  heartbeatMs: 15000,
} as const
