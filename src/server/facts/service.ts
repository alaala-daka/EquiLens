import { createHash } from "node:crypto"
import { z } from "zod"
import { FactError, type SourceAnchor, type SaveProjectFact } from "@/lib/facts/types"
import { quotesMatch } from "@/lib/business/verification-fields"
import type { AuthIdentity } from "../auth/service"
import type { MaterialRepository } from "../materials/repository"
import { BusinessError } from "../projects/errors"
import type { ResultAuthorizer, ResultSource } from "../results/service"
import { canonicalJson } from "../results/validation"
import { retentionExpired } from "../reviews/input"
import { FactRepository } from "./repository"

const text = (max = 500) => z.string().trim().min(1).max(max)
const day = z.iso.date()
export const projectSourceSchema = z.object({
  projectId: text(128), materialId: text(128), materialVersionId: text(128), parseSnapshotId: text(128),
  fragmentId: text(128), quote: text(10000), locator: text().optional(), paragraphIndex: z.number().int().nonnegative().optional(),
}).strict()
export const projectFactDraftSchema = z.object({
  contractId: text(128).optional(), subject: text().optional(), field: text(), occurredAt: day.optional(), periodStart: day.optional(), periodEnd: day.optional(),
  nature: z.enum(["材料记载", "人工陈述", "拟约定", "程序计算"]), originalValue: text().optional(), candidates: z.array(text()).max(100).optional(),
  selectedValue: text().optional(), unit: text().optional(), caliber: text().optional(), sources: z.array(projectSourceSchema).max(100), conflicts: z.array(projectSourceSchema).max(100),
  confirmation: z.enum(["未确认", "已确认", "待核实"]), support: z.enum(["材料支持", "仅人工陈述", "材料冲突", "缺少支持"]), reason: text().optional(),
}).strict()
export const saveProjectFactSchema = z.object({ operationId: text(128), factId: text(128).optional(), baseVersionId: z.string().max(128), reason: text(), value: projectFactDraftSchema }).strict()

export type FactMaterialRepository = Pick<MaterialRepository, "versionById" | "findMaterial" | "findSnapshot" | "findFragment">
const invalidSource = () => new BusinessError("INVALID_SOURCE", "事实来源无效或已过期，请重新选择材料。")

/** Shared by facts and payments: only active project material snapshots may support a value. */
export async function validateProjectFactSources(repository: FactMaterialRepository, projectId: string, sources: SourceAnchor[], now = new Date()): Promise<void> {
  for (const source of sources) {
    if (source.projectId !== projectId || !source.materialId || !source.materialVersionId || !source.fragmentId || source.documentId || source.documentVersionId) throw invalidSource()
    const version = await repository.versionById(projectId, source.materialVersionId)
    if (!version || version.materialId !== source.materialId) throw invalidSource()
    const material = await repository.findMaterial(projectId, source.materialId)
    if (!material || material.status !== "active" || !material.processingAuthorized || retentionExpired(material.retentionUntil, now)) throw invalidSource()
    const snapshot = await repository.findSnapshot(projectId, source.parseSnapshotId)
    if (!snapshot || snapshot.materialId !== source.materialId || snapshot.versionId !== version.id) throw invalidSource()
    const fragment = await repository.findFragment(projectId, snapshot.id, source.fragmentId)
    if (!fragment || !quotesMatch(fragment.text, source.quote)) throw invalidSource()
  }
}

export function sourceAnchorToResultSource(source: SourceAnchor): ResultSource {
  if (!source.fragmentId) throw invalidSource()
  return { fragmentId: source.fragmentId, snapshotId: source.parseSnapshotId, quote: source.quote }
}

export function factBusinessError(failure: unknown): never {
  if (!(failure instanceof FactError)) throw failure
  if (failure.code === "FACT_NOT_FOUND") throw new BusinessError("NOT_FOUND", "找不到该事实。")
  if (failure.code === "FACT_CONFLICT") throw new BusinessError("CONFLICT", "事实版本已变化，请重新读取后保存。")
  if (failure.code === "FACT_INTEGRITY_FAILED") throw new BusinessError("SERVICE_UNAVAILABLE", "事实版本校验失败。")
  throw new BusinessError("INVALID_SOURCE", failure.message)
}

export class FactService {
  constructor(private readonly dependencies: {
    facts: FactRepository; materials: FactMaterialRepository; readProjectRetention(projectId: string): Promise<string | null>; now?: () => Date
  }) {}
  private async access(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, action: "read" | "edit") {
    const granted = await authorize(identity, projectId, action)
    if (granted.projectId !== projectId || (action === "edit" && granted.role === "viewer")) throw new BusinessError("FORBIDDEN", "无权操作项目事实。")
  }
  async list(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, contractId?: string) {
    await this.access(identity, authorize, projectId, "read")
    try { return await this.dependencies.facts.listLatest(projectId, contractId) } catch (failure) { factBusinessError(failure) }
  }
  async history(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, factId: string) {
    await this.access(identity, authorize, projectId, "read")
    try { return await this.dependencies.facts.history(projectId, factId) } catch (failure) { factBusinessError(failure) }
  }
  async save(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, request: SaveProjectFact) {
    await this.access(identity, authorize, projectId, "edit")
    const parsed = saveProjectFactSchema.safeParse(request)
    if (!parsed.success) throw new BusinessError("INVALID_INPUT", "事实输入无效，请检查字段。")
    const input = parsed.data
    const now = this.dependencies.now?.() ?? new Date()
    const retention = await this.dependencies.readProjectRetention(projectId)
    if (!retention || retentionExpired(retention, now)) throw invalidSource()
    await validateProjectFactSources(this.dependencies.materials, projectId, [...input.value.sources, ...input.value.conflicts], now)
    if (input.factId && !await this.dependencies.facts.latest(projectId, input.factId)) throw new BusinessError("NOT_FOUND", "找不到该事实。")
    // Authorization can change while sources are read; recheck immediately before persistence.
    await this.access(identity, authorize, projectId, "edit")
    const requestHash = createHash("sha256").update(canonicalJson({ projectId, actor: identity.account.id, ...input })).digest("hex")
    try {
      return await this.dependencies.facts.save(projectId, { ...input.value, projectId, createdBy: identity.account.id, reason: input.reason,
        ...(input.factId ? { factId: input.factId } : {}), baseVersionId: input.baseVersionId }, { operationId: input.operationId, requestHash })
    } catch (failure) { factBusinessError(failure) }
  }
}
