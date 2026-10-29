/** A project host owns removal of views and isolation of unsaved inputs. */
export function createProtectedResources(clearViews: () => void) {
  let generation = 0
  let allowed = true
  const requests = new Set<AbortController>()
  const urls = new Set<string>()
  return {
    allowed: () => allowed,
    begin() {
      if (!allowed) throw new Error("会话已失效。")
      const current = generation
      const controller = new AbortController()
      requests.add(controller)
      return { signal: controller.signal, current: () => allowed && generation === current, finish: () => { requests.delete(controller) } }
    },
    trackUrl(url: string) { if (!allowed) { URL.revokeObjectURL(url); return }; urls.add(url) },
    clear() {
      allowed = false
      generation++
      for (const request of requests) request.abort()
      requests.clear()
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
      clearViews()
    },
  }
}
