import { modelConfig } from "./client"

export type RoleModels = { router: string; primary: string; auditor: string }
export function roleModels(env: Record<string, string | undefined>): RoleModels {
  const resolve = (name: string) => modelConfig({ ...env, AI_MODEL: env[name]?.trim() || env.AI_MODEL }).model
  return { router: resolve("AI_ROUTER_MODEL"), primary: resolve("AI_PRIMARY_MODEL"), auditor: resolve("AI_AUDIT_MODEL") }
}
/** 已保存任务只使用其固定模型；修订属于主审档，不能因部署环境变更模型。 */
export function roleEnvironment(env: Record<string, string | undefined> | undefined, models: RoleModels | undefined, role: keyof RoleModels) {
  return models ? { ...(env ?? process.env), AI_MODEL: models[role] } : env
}
