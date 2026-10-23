import type { AnonymousSessionView } from "./session-types"

export type SessionRequestState = { generation: number; controller: AbortController | null }

// Creation fixes the deadline transactionally. Supersede pre-create reads, but
// do not cancel the operation which must still publish its saved document.
export async function readCreatedSession(
  state: SessionRequestState,
  operationSignal: AbortSignal,
  read: (signal: AbortSignal) => Promise<AnonymousSessionView>,
): Promise<AnonymousSessionView | null> {
  operationSignal.throwIfAborted()
  state.controller?.abort()
  const generation = ++state.generation
  const controller = new AbortController()
  state.controller = controller
  try {
    const view = await read(AbortSignal.any([operationSignal, controller.signal]))
    operationSignal.throwIfAborted()
    if (generation !== state.generation || controller.signal.aborted) return null
    return view
  } catch (failure) {
    operationSignal.throwIfAborted()
    if (generation !== state.generation || controller.signal.aborted) return null
    throw failure
  }
}
