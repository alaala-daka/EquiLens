import { z } from "zod"
import type { CollectionLetterDraft, LetterEvidenceSnapshot, LetterFactSnapshot, LetterPaymentSnapshot, SaveCollectionLetter } from "@/lib/letters/types"
import type { PaymentReconciliationValue } from "@/lib/payments/types"
import type { AuthIdentity } from "../auth/service"
import type { FactRepository } from "../facts/repository"
import { BusinessError } from "../projects/errors"
import type { ResultAuthorizer, ResultService } from "../results/service"
import type { ResultView } from "../results/service"
import { retentionExpired } from "../reviews/input"
import { buildCollectionLetter } from "./validation"

const text = (max = 500) => z.string().trim().min(1).max(max)
const day = z.iso.date()
const versionRef = z.object({ resultId: text(64), versionId: text(64), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const saveCollectionLetterSchema = z.object({
  operationId: text(128), reason: text(), baseVersionId: z.string().max(64),
  value: z.object({
    cutoff: day, contractTitle: z.string().trim().max(200), sender: z.string().trim().max(200), recipient: z.string().trim().max(200),
    demand: z.string().trim().max(500), plannedDate: z.string().trim().max(40), method: z.string().trim().max(100), address: z.string().trim().max(200),
    payment: versionRef, factVersionIds: z.array(text(64)).min(1).max(100), evidence: versionRef.optional(),
  }).strict(),
}).strict()

const invalid = (message: string): never => { throw new BusinessError("INVALID_SOURCE", message) }

/** 项目催款函服务：重新读取所选版本、固定快照并由服务端确定性渲染正文。 */
export class LetterService {
  constructor(private readonly dependencies: {
    results: Pick<ResultService, "get" | "saveResultRevision">
    facts: Pick<FactRepository, "version">
    readProjectRetention(projectId: string): Promise<string | null>
    now?: () => Date
  }) {}

  private async access(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, action: "read" | "edit") {
    const granted = await authorize(identity, projectId, action)
    if (granted.projectId !== projectId || (action === "edit" && granted.role === "viewer")) throw new BusinessError("FORBIDDEN", "无权操作项目催款函。")
  }

  private async paymentSnapshot(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, draft: CollectionLetterDraft): Promise<LetterPaymentSnapshot> {
    let view: ResultView
    try { view = await this.dependencies.results.get(identity, authorize, projectId, draft.payment.resultId, draft.payment.versionId) }
    catch { return invalid("所选款项成果不存在或不属于当前项目。") }
    if (view.kind !== "payment-reconciliation" || view.sha256 !== draft.payment.sha256) return invalid("所选款项成果版本与摘要不一致。")
    if (view.validation.status !== "valid") return invalid("所选款项成果未通过校验，不能作为催款依据。")
    const value = view.value as PaymentReconciliationValue
    if (!value.calculation || value.status !== "conditional") return invalid("所选款项成果不是可计算的有条件测算，不能作为催款依据。")
    if (BigInt(value.calculation.unpaidFen) <= BigInt(0)) return invalid("所选款项成果的已到期未付金额必须为正。")
    const rows = value.rows.filter(row => ["净应付", "计付基数", "付款", "扣项"].includes(row.nature))
    // 款项记录中付款方对应收函方，收款方对应发函方。
    if (rows.some(row => (row.payer && row.payer !== draft.recipient) || (row.payee && row.payee !== draft.sender)))
      return invalid("发函或收函主体与款项记录的对应关系不一致。")
    return { resultId: draft.payment.resultId, versionId: draft.payment.versionId, sha256: view.sha256,
      netDueFen: value.calculation.netDueFen, paidFen: value.calculation.paidFen, unpaidFen: value.calculation.unpaidFen, formula: value.calculation.formula }
  }

  private async evidenceSnapshot(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, draft: CollectionLetterDraft): Promise<LetterEvidenceSnapshot | undefined> {
    if (!draft.evidence) return undefined
    let view: ResultView
    try { view = await this.dependencies.results.get(identity, authorize, projectId, draft.evidence.resultId, draft.evidence.versionId) }
    catch { return invalid("所选证据报告不存在或不属于当前项目。") }
    if (view.kind !== "evidence-report" || view.sha256 !== draft.evidence.sha256) return invalid("所选证据报告版本与摘要不一致。")
    const status = (view.value as { status?: string }).status
    if (status !== "draft" && status !== "incomplete") return invalid("所选证据报告状态无法识别。")
    return { resultId: draft.evidence.resultId, versionId: draft.evidence.versionId, sha256: view.sha256, status }
  }

  async save(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, request: SaveCollectionLetter & { resultId?: string }) {
    await this.access(identity, authorize, projectId, "edit")
    const parsed = saveCollectionLetterSchema.safeParse({ operationId: request.operationId, reason: request.reason, baseVersionId: request.baseVersionId, value: request.value })
    if (!parsed.success) throw new BusinessError("INVALID_INPUT", "催款函输入无效，请检查字段。")
    const input = parsed.data
    const now = this.dependencies.now?.() ?? new Date()
    const retention = await this.dependencies.readProjectRetention(projectId)
    if (!retention || retentionExpired(retention, now)) throw new BusinessError("INVALID_SOURCE", "项目保留期限已到期。")
    if (request.resultId && !input.baseVersionId) throw new BusinessError("CONFLICT", "请指定催款函基础版本。")
    if (!request.resultId && input.baseVersionId) throw new BusinessError("INVALID_INPUT", "新建催款函不能指定基础版本。")
    const unique = [...new Set(input.value.factVersionIds)]
    if (unique.length !== input.value.factVersionIds.length) throw new BusinessError("INVALID_INPUT", "事实版本重复。")
    const facts: LetterFactSnapshot[] = []
    for (const factVersionId of unique) {
      let fact
      try { fact = await this.dependencies.facts.version(projectId, factVersionId) }
      catch { return invalid("事实版本不存在或不属于当前项目。") }
      if (fact.confirmation !== "已确认") return invalid("催款函只引用已确认的项目事实版本。")
      facts.push({ factId: fact.factId, factVersionId: fact.factVersionId, field: fact.field, ...(fact.selectedValue ? { selectedValue: fact.selectedValue } : {}) })
    }
    const payment = await this.paymentSnapshot(identity, authorize, projectId, input.value)
    const evidence = await this.evidenceSnapshot(identity, authorize, projectId, input.value)
    const value = buildCollectionLetter(input.value, { payment, facts, ...(evidence ? { evidence } : {}) })
    await this.access(identity, authorize, projectId, "edit")
    const dependencies = [
      { kind: "result" as const, id: input.value.payment.resultId, versionId: input.value.payment.versionId },
      ...facts.map(fact => ({ kind: "fact" as const, id: fact.factId, versionId: fact.factVersionId })),
      ...(evidence ? [{ kind: "result" as const, id: evidence.resultId, versionId: evidence.versionId }] : []),
    ]
    return this.dependencies.results.saveResultRevision(identity, authorize, {
      projectId, ...(request.resultId ? { resultId: request.resultId } : {}), kind: "collection-letter",
      baseVersionId: input.baseVersionId, operationId: input.operationId, reason: input.reason, value,
      sources: [], dependencies: [...new Map(dependencies.map(item => [JSON.stringify(item), item])).values()],
    }, undefined, { serverOwned: true })
  }
}
