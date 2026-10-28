import { routeScene, type RoutingResult } from "./router"

/** 自动识别与手选/CLI 适配共用；用户选择不进入路由上下文，不影响其独立判断。 */
export async function checkSceneApplicability(options: Parameters<typeof routeScene>[0]): Promise<RoutingResult> {
  const requested = options.context.scene
  const context = { role: options.context.role, ...(options.context.region ? { region: options.context.region } : {}) }
  const result = await routeScene({ ...options, context })
  return enforceRequestedScene(result, requested)
}

export function enforceRequestedScene(result: RoutingResult, requested?: string): RoutingResult {
  if (!requested || requested === "auto" || !result.selection || result.selection.status !== "matched" || result.selection.sceneId === requested) return result
  return { ...result, selection: { ...result.selection, status: "unsupported", sceneId: null,
    reason: "正文适配的场景与所选场景不一致，未进入主审。" + result.selection.reason, missingInfo: [] } }
}
