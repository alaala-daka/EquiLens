import type { SaveProjectPayment } from "@/lib/payments/types"
import { FactError } from "@/lib/facts/types"
import type { AuthIdentity } from "../auth/service"
import type { FactRepository } from "../facts/repository"
import { validateProjectFactSources, sourceAnchorToResultSource } from "../facts/service"
import type { MaterialRepository } from "../materials/repository"
import { BusinessError } from "../projects/errors"
import type { ResultAuthorizer, ResultDependency, ResultService } from "../results/service"
import { buildPaymentReconciliationValue, parseProjectPaymentDraft } from "./result-validator"

export class PaymentsService {
  constructor(private readonly dependencies: {
    results: ResultService
    materials: Pick<MaterialRepository, "versionById" | "findMaterial" | "findSnapshot" | "findFragment">
    facts: Pick<FactRepository, "version">
    now?: () => Date
  }) {}

  async save(identity: AuthIdentity, authorize: ResultAuthorizer, input: SaveProjectPayment & { projectId: string; resultId?: string }) {
    const access = await authorize(identity, input.projectId, "edit")
    if (access.projectId !== input.projectId || access.role === "viewer") throw new BusinessError("FORBIDDEN", "无权保存款项核对表。")
    const draft = parseProjectPaymentDraft(input.value)
    if (!draft || !input.operationId?.trim() || input.operationId.length > 128 || !input.reason?.trim() || input.reason.length > 500) throw new BusinessError("INVALID_INPUT", "款项输入无效。")
    if (input.resultId) {
      const previous = await this.dependencies.results.get(identity, authorize, input.projectId, input.resultId)
      if (previous.kind !== "payment-reconciliation") throw new BusinessError("NOT_FOUND", "找不到该款项成果。")
      if (!input.baseVersionId) throw new BusinessError("CONFLICT", "请指定款项基础版本。")
    } else if (input.baseVersionId) throw new BusinessError("INVALID_INPUT", "新建款项表不能指定基础版本。")
    const sources = draft.rows.flatMap(row => row.source ? [row.source] : [])
    await validateProjectFactSources(this.dependencies.materials, input.projectId, sources, this.dependencies.now?.() ?? new Date())
    const dependencies: ResultDependency[] = []
    for (const ref of draft.facts) {
      let fact
      try { fact = await this.dependencies.facts.version(input.projectId, ref.factVersionId) }
      catch (error) {
        if (error instanceof FactError) throw new BusinessError("INVALID_SOURCE", "事实版本不存在或不属于当前项目。")
        throw error
      }
      if (fact.factId !== ref.factId || (draft.contractId && fact.contractId && fact.contractId !== draft.contractId)) throw new BusinessError("INVALID_SOURCE", "事实版本不属于当前合同或项目。")
      const used = draft.rows.some(row => row.factVersionIds?.includes(ref.factVersionId))
      if (used && (fact.confirmation !== "已确认" || fact.evidenceStatus !== "材料支持" || fact.conflicts.length || fact.nature === "拟约定" || fact.nature === "人工陈述")) throw new BusinessError("INVALID_SOURCE", "款项引用事实尚未核实或缺少材料支持。")
      await validateProjectFactSources(this.dependencies.materials, input.projectId, [...fact.sources, ...fact.conflicts], this.dependencies.now?.() ?? new Date())
      sources.push(...fact.sources, ...fact.conflicts)
      dependencies.push({ kind: "fact", id: fact.factId, versionId: fact.factVersionId })
    }
    for (const source of sources) if (source.materialId && source.materialVersionId) dependencies.push({ kind: "material", id: source.materialId, versionId: source.materialVersionId })
    const unique = <T,>(items: T[]) => [...new Map(items.map(item => [JSON.stringify(item), item])).values()]
    return this.dependencies.results.saveResultRevision(identity, authorize, {
      projectId: input.projectId, ...(input.resultId ? { resultId: input.resultId } : {}), kind: "payment-reconciliation",
      baseVersionId: input.baseVersionId ?? "", operationId: input.operationId, reason: input.reason,
      value: buildPaymentReconciliationValue(draft), sources: unique(sources.map(sourceAnchorToResultSource)), dependencies: unique(dependencies),
    }, undefined, { serverOwned: true })
  }
}
