export function createMaterialLifecycle(deps: {
  register(): void
  repair(): Promise<void>
  schedule(callback: () => void): unknown
  report(): void
}) {
  let started = false
  async function tick() {
    try { await deps.repair() } catch { deps.report() }
    deps.schedule(() => { void tick() })
  }
  return { start() { if (started) return; started = true; deps.register(); void tick() } }
}

/** Authorization is awaited afresh before every recovery submission. */
export async function recoverAuthorizedMaterial<T>(authorize: () => Promise<unknown>, submit: () => Promise<T>): Promise<T> {
  await authorize()
  return submit()
}
