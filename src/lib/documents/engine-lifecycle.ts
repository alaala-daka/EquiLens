export function createEngineLoad(options: { timeoutMs: number; onTimeout: () => void }) {
  const controller = new AbortController()
  let current = true
  let loaded = false
  const dispose = () => {
    if (!current) return
    current = false
    clearTimeout(timer)
    controller.abort()
  }
  const timer = setTimeout(() => {
    if (!current || loaded) return
    dispose()
    options.onTimeout()
  }, options.timeoutMs)

  return {
    signal: controller.signal,
    isCurrent: () => current,
    ready() {
      if (!current || loaded) return false
      loaded = true
      clearTimeout(timer)
      return true
    },
    dispose,
  }
}
