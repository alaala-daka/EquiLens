/**
 * Independent single-flight request gate (C1 fix).
 *
 * List refreshes and project-switch reauthorization must not share a ticket or
 * AbortController: a focus-triggered list refresh previously aborted an in-flight
 * switch, and the switch's guarded `finally` then never cleared its busy flag.
 * Each gate owns its own ticket/controller; starting a request supersedes only
 * requests from the same gate.
 */
export type RequestGate = {
  /** Supersede this gate's previous request and start a new one. */
  begin(): { ticket: number; signal: AbortSignal }
  /** True while this ticket is the gate's most recent request. */
  isCurrent(ticket: number): boolean
  /** Release this ticket's controller only when it is still the latest request. */
  finish(ticket: number): void
  /** Supersede and abort the current request (e.g. unmount or another operation). */
  cancel(): void
}

export function createRequestGate(): RequestGate {
  let ticket = 0
  let controller: AbortController | null = null
  return {
    begin() {
      ticket += 1
      controller?.abort()
      const next = new AbortController()
      controller = next
      return { ticket, signal: next.signal }
    },
    isCurrent(value) {
      return value === ticket
    },
    finish(value) {
      if (value === ticket) controller = null
    },
    cancel() {
      ticket += 1
      controller?.abort()
      controller = null
    },
  }
}
