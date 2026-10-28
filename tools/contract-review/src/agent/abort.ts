export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((accept, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => { cleanup(); reject(signal.reason) }
    if (signal.aborted) { void promise.catch(() => {}); reject(signal.reason); return }
    signal.addEventListener("abort", abort, { once: true })
    promise.then(value => { cleanup(); accept(value) }, failure => { cleanup(); reject(failure) })
  })
}
