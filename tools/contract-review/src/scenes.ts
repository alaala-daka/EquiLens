import type { ReviewContext } from "./types"

/** 场景是判定的唯一依据：规则按 scene 匹配，中文名称只用于展示。 */
export const sceneIds = ["mep-sub-2026", "decoration-sub-2026", "curtain-wall-sub-2026", "steel-structure-sub-2026"] as const
export const skillIds = ["contract-review", "decoration-review", "curtain-wall-review", "steel-structure-review"] as const
export const revisionSkillIds = ["mep-revision", "decoration-revision", "curtain-wall-revision", "steel-structure-revision"] as const
export const revisionSkillForScene = Object.fromEntries(sceneIds.map((id, index) => [id, revisionSkillIds[index]])) as Record<typeof sceneIds[number], typeof revisionSkillIds[number]>
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
  version: string
  description: string
  exclusions: string[]
}

export type SceneCandidate = Pick<Scene, "id" | "label" | "role" | "skillId" | "version" | "description" | "exclusions">

function extension(id: SceneId, label: string, skillId: string, description: string): Scene {
  return { id, label, role: "专业分包人", skillId, version: "1-draft", description,
    rulesDir: "tools/contract-review/rules/scenarios/" + id, skillsRoot: "tools/contract-review/skills",
    exclusions: ["非房建工程", "劳务、采购、租赁、总承包或其他专业合同", "跨专业混合且无法确定本次合同范围，需补充材料"] }
}

export const scenes: Record<SceneId, Scene> = {
  "mep-sub-2026": {
    id: "mep-sub-2026",
    label: "房建机电安装专业分包",
    role: "专业分包人",
    rulesDir: "tools/contract-review/rules",
    skillsRoot: "tools/contract-review/skills",
    skillId: "contract-review",
    version: "1",
    description: "房屋建筑工程中的机电安装专业分包合同，正文须支持房建工程、机电安装范围和专业分包合同关系。住宅、办公楼及商业建筑均可；不得仅凭标题判断。",
    exclusions: ["市政、道路桥梁、水利等非房建工程", "劳务分包、设备采购、租赁或总承包合同", "合同关系或工程范围无法确定，或者正文与标题冲突"],
  },
  "decoration-sub-2026": extension("decoration-sub-2026", "房建装饰装修专业分包", "decoration-review",
    "房屋建筑工程的室内外装饰装修专业分包，含饰面、吊顶、地面、涂饰等。须有专业分包合同关系；不含独立幕墙、钢结构或机电安装合同。"),
  "curtain-wall-sub-2026": extension("curtain-wall-sub-2026", "房建幕墙专业分包", "curtain-wall-review",
    "房屋建筑工程的独立建筑幕墙专业分包，范围含玻璃、金属或石材幕墙体系的深化、制作或安装。须有专业分包合同关系；普通墙面装修不能仅凭外墙字样匹配。"),
  "steel-structure-sub-2026": extension("steel-structure-sub-2026", "房建钢结构专业分包", "steel-structure-review",
    "房屋建筑工程的钢结构专业分包，范围含建筑钢构件制作、连接或安装。须有专业分包合同关系；桥梁钢结构、钢材采购或设备安装不能直接套用。"),
}

export const defaultSceneId: SceneId = "mep-sub-2026"

export function isSceneId(value: unknown): value is SceneId {
  return typeof value === "string" && (sceneIds as readonly string[]).includes(value)
}

export function sceneOf(id: SceneId): Scene {
  return scenes[id]
}

/** 仅返回可提供给模型的场景元数据，不暴露文件路径。每个任务固定此目录。 */
export function sceneCatalog(): SceneCandidate[] {
  return sceneIds.map(id => {
    const { label, role, skillId, version, description, exclusions } = scenes[id]
    return { id, label, role, skillId, version, description, exclusions: [...exclusions] }
  })
}

/** 组装审查上下文：scene 用于判定，role 参与判定，projectType 仅作展示与报告。 */
export function sceneContext(id: SceneId, region?: string): ReviewContext {
  const scene = scenes[id]
  const trimmed = region?.trim()
  return { scene: id, role: scene.role, projectType: scene.label, ...(trimmed ? { region: trimmed } : {}) }
}
