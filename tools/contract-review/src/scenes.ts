import type { ReviewContext } from "./types"

/** 场景是判定的唯一依据：规则按 scene 匹配，中文名称只用于展示。 */
export const sceneIds = ["mep-sub-2026"] as const
export type SceneId = typeof sceneIds[number]

export type Scene = {
  id: SceneId
  /** 仅供界面与报告展示，不参与任何匹配。 */
  label: string
  /** 规则判定使用的审查立场。 */
  role: string
  rulesDir: string
  skillsRoot: string
  skillId: string
}

export const scenes: Record<SceneId, Scene> = {
  "mep-sub-2026": {
    id: "mep-sub-2026",
    label: "房建机电安装专业分包",
    role: "专业分包人",
    rulesDir: "tools/contract-review/rules",
    skillsRoot: "tools/contract-review/skills",
    skillId: "contract-review",
  },
}

export const defaultSceneId: SceneId = "mep-sub-2026"

export function isSceneId(value: unknown): value is SceneId {
  return typeof value === "string" && (sceneIds as readonly string[]).includes(value)
}

export function sceneOf(id: SceneId): Scene {
  return scenes[id]
}

/** 组装审查上下文：scene 用于判定，role 参与判定，projectType 仅作展示与报告。 */
export function sceneContext(id: SceneId, region?: string): ReviewContext {
  const scene = scenes[id]
  const trimmed = region?.trim()
  return { scene: id, role: scene.role, projectType: scene.label, ...(trimmed ? { region: trimmed } : {}) }
}
