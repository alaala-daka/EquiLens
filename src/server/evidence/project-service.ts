import { createHash } from "node:crypto"
import { z } from "zod"
import type { SourceAnchor } from "@/lib/facts/types"
import {
  CONFIRMATION_STATUSES, EVIDENCE_ITEM_KINDS, EVIDENCE_SUPPORTS, EvidenceError,
  type EvidenceItem, type EvidenceItemInput, type SaveEvidenceItem, type SaveEvidenceReport,
} from "@/lib/evidence/types"
import type { AuthIdentity } from "../auth/service"
import type { FactRepository } from "../facts/repository"
import { validateProjectFactSources } from "../facts/service"
import type { FactMaterialRepository } from "../facts/service"
import { BusinessError } from "../projects/errors"
import type { ResultAuthorizer, ResultDependency, ResultService, ResultSource } from "../results/service"
import { canonicalJson } from "../results/validation"
import { retentionExpired } from "../reviews/input"
import type { EvidenceRepository } from "./repository"
import { buildEvidenceReportValue } from "./result-validator"

const text = (max = 500) => z.string().trim().min(1).max(max)
const day = z.iso.date()
const fen = z.string().regex(/^-?(?:0|[1-9]\d{0,29})$/)
const sourceSchema = z.object({
  projectId: text(128), quote: z.string().min(1).max(2000), parseSnapshotId: text(128),
  materialId: text(128).optional(), materialVersionId: text(128).optional(),
  documentId: text(128).optional(), documentVersionId: text(128).optional(),
  fragmentId: text(128).optional(), paragraphIndex: z.number().int().nonnegative().optional(), locator: text().optional(),
}).strict()
const linkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fact"), factId: text(64), factVersionId: text(64) }).strict(),
  z.object({ kind: z.literal("payment"), ledgerRevisionId: text(64), rowId: text(64), resultId: text(64).optional() }).strict(),
  z.object({ kind: z.literal("clause"), source: sourceSchema }).strict(),
  z.object({ kind: z.literal("dispute"), evidenceReportRevisionId: text(64), disputeId: text(64), resultId: text(64).optional() }).strict(),
])
const itemDraftSchema = z.object({
  contractId: text(128).optional(), kind: z.enum(EVIDENCE_ITEM_KINDS), title: text(200),
  occurredAt: day.optional(), period: z.object({ start: day.optional(), end: day.optional() }).strict().optional(),
  originalValue: text(200).optional(), candidates: z.array(text(200)).max(50).optional(), selectedValue: text(200).optional(),
  unit: text(50).optional(), caliber: text(200).optional(), sources: z.array(sourceSchema).max(50), conflicts: z.array(sourceSchema).max(50),
  confirmation: z.enum(CONFIRMATION_STATUSES), support: z.enum(EVIDENCE_SUPPORTS), links: z.array(linkSchema).max(100),
  pendingLinks: z.array(z.enum(["fact", "payment", "clause", "dispute"])).optional(),
  note: z.string().max(2000).optional(), reason: z.string().max(500).optional(),
}).strict()
export const saveEvidenceItemSchema = z.object({ operationId: text(128), itemId: text(64).optional(), baseVersionId: z.string().max(64), reason: text(), value: itemDraftSchema }).strict()
const timelineSchema = z.object({ id: text(64), at: text(40), title: text(200), detail: text(1000).optional(), evidenceVersionIds: z.array(text(64)).max(200) }).strict()
const disputeSchema = z.object({ id: text(64), title: text(200), claimAmountFen: fen.optional(), evidenceVersionIds: z.array(text(64)).max(200), status: z.enum(CONFIRMATION_STATUSES), note: z.string().max(1000).optional() }).strict()
const gapSchema = z.object({ id: text(64), description: text(500), relatedDisputeId: text(64).optional(), status: z.enum(["开放", "已补正"]) }).strict()
const suggestionSchema = z.object({ id: text(64), text: text(500), dependsOnVersionIds: z.array(text(64)).max(200) }).strict()
export const saveEvidenceReportSchema = z.object({
  operationId: text(128), reason: text(), baseVersionId: z.string().max(64),
  value: z.object({ cutoff: day, contractId: text(128).optional(), itemVersionIds: z.array(text(64)).min(1).max(200),
    timeline: z.array(timelineSchema).max(200), disputes: z.array(disputeSchema).max(100), gaps: z.array(gapSchema).max(200),
    suggestions: z.array(suggestionSchema).max(200) }).strict(),
}).strict()

function evidenceError(failure: unknown): never {
  if (!(failure instanceof EvidenceError)) throw failure
  if (failure.code === "EVIDENCE_NOT_FOUND") throw new BusinessError("NOT_FOUND", "找不到证据版本。")
  if (failure.code === "EVIDENCE_CONFLICT") throw new BusinessError("CONFLICT", "证据版本已变化，请重新读取后保存。")
  if (failure.code === "EVIDENCE_INTEGRITY_FAILED") throw new BusinessError("SERVICE_UNAVAILABLE", "证据版本校验失败。")
  throw new BusinessError("INVALID_SOURCE", failure.message)
}

export class EvidenceProjectService {
  constructor(private readonly dependencies: {
    repository: EvidenceRepository
    materials: FactMaterialRepository
    facts: Pick<FactRepository, "version">
    results: Pick<ResultService, "get" | "saveResultRevision">
    readProjectRetention(projectId: string): Promise<string | null>
    now?: () => Date
  }) {}

  private async access(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, action: "read" | "edit") {
    const granted = await authorize(identity, projectId, action)
    if (granted.projectId !== projectId || (action === "edit" && granted.role === "viewer")) throw new BusinessError("FORBIDDEN", "无权操作项目证据。")
  }

  async listItems(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, contractId?: string) {
    await this.access(identity, authorize, projectId, "read")
    try { return await this.dependencies.repository.latestItems(projectId, contractId) } catch (failure) { evidenceError(failure) }
  }

  async history(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, itemId: string) {
    await this.access(identity, authorize, projectId, "read")
    try { return await this.dependencies.repository.history(projectId, itemId) } catch (failure) { evidenceError(failure) }
  }

  private async checkLinks(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, links: EvidenceItemInput["links"], now: Date) {
    for (const link of links) {
      if (link.kind === "fact") {
        const fact = await this.factVersion(projectId, link.factVersionId)
        if (fact.factId !== link.factId) throw new BusinessError("INVALID_SOURCE", "事实版本与事实标识不一致。")
      } else if (link.kind === "payment") {
        if (!link.resultId) throw new BusinessError("INVALID_SOURCE", "款项链接缺少成果标识。")
        const view = await this.dependencies.results.get(identity, authorize, projectId, link.resultId, link.ledgerRevisionId)
        if (view.kind !== "payment-reconciliation") throw new BusinessError("INVALID_SOURCE", "款项链接指向非款项成果。")
        const rows = (view.value as { rows?: Array<{ rowId?: string }> }).rows
        if (!Array.isArray(rows) || !rows.some(row => row.rowId === link.rowId)) throw new BusinessError("INVALID_SOURCE", "款项行不存在或已变化。")
      } else if (link.kind === "clause") {
        await validateProjectFactSources(this.dependencies.materials, projectId, [link.source as SourceAnchor], now)
      } else if (link.kind === "dispute") {
        if (!link.resultId) throw new BusinessError("INVALID_SOURCE", "争点链接缺少报告成果标识。")
        const view = await this.dependencies.results.get(identity, authorize, projectId, link.resultId, link.evidenceReportRevisionId)
        if (view.kind !== "evidence-report") throw new BusinessError("INVALID_SOURCE", "争点链接指向非证据报告成果。")
        const disputes = (view.value as { disputes?: Array<{ id?: string }> }).disputes
        if (!Array.isArray(disputes) || !disputes.some(dispute => dispute.id === link.disputeId)) throw new BusinessError("INVALID_SOURCE", "争点不存在或已变化。")
      }
    }
  }

  private async factVersion(projectId: string, factVersionId: string) {
    try { return await this.dependencies.facts.version(projectId, factVersionId) }
    catch (failure) {
      if ((failure as { name?: string }).name === "FactError") throw new BusinessError("INVALID_SOURCE", "事实版本不存在或不属于当前项目。")
      throw failure
    }
  }

  async saveItem(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, request: SaveEvidenceItem) {
    await this.access(identity, authorize, projectId, "edit")
    const parsed = saveEvidenceItemSchema.safeParse(request)
    if (!parsed.success) throw new BusinessError("INVALID_INPUT", "证据项输入无效，请检查字段。")
    const input = parsed.data
    const now = this.dependencies.now?.() ?? new Date()
    const retention = await this.dependencies.readProjectRetention(projectId)
    if (!retention || retentionExpired(retention, now)) throw new BusinessError("INVALID_SOURCE", "项目保留期限已到期。")
    const sources = [...input.value.sources, ...input.value.conflicts] as SourceAnchor[]
    await validateProjectFactSources(this.dependencies.materials, projectId, sources, now)
    await this.checkLinks(identity, authorize, projectId, input.value.links, now)
    if (input.itemId && !await this.dependencies.repository.latestItem(projectId, input.itemId)) throw new BusinessError("NOT_FOUND", "找不到要更正的事实。")
    // 授权可能在读取来源期间变化，写入前立即重验。
    await this.access(identity, authorize, projectId, "edit")
    const value: EvidenceItemInput = { ...input.value, projectId, createdBy: identity.account.id, ...(input.reason ? { reason: input.reason } : {}) }
    const requestHash = createHash("sha256").update(canonicalJson({ projectId, actor: identity.account.id, ...input, value })).digest("hex")
    try {
      return await this.dependencies.repository.saveItem({ ...value, ...(input.itemId ? { itemId: input.itemId } : {}) },
        { operationId: input.operationId, requestHash, baseVersionId: input.baseVersionId })
    } catch (failure) { evidenceError(failure) }
  }

  /** 只读打开所选保存版本（Markdown 导出与页面使用同一版本，不重新生成）。 */
  async report(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, resultId: string, versionId?: string) {
    await this.access(identity, authorize, projectId, "read")
    return this.dependencies.results.get(identity, authorize, projectId, resultId, versionId)
  }

  async saveReport(identity: AuthIdentity, authorize: ResultAuthorizer, projectId: string, request: SaveEvidenceReport & { resultId?: string }) {
    await this.access(identity, authorize, projectId, "edit")
    const parsed = saveEvidenceReportSchema.safeParse({ operationId: request.operationId, reason: request.reason, baseVersionId: request.baseVersionId, value: request.value })
    if (!parsed.success) throw new BusinessError("INVALID_INPUT", "证据报告输入无效，请检查字段。")
    const input = parsed.data
    const now = this.dependencies.now?.() ?? new Date()
    const retention = await this.dependencies.readProjectRetention(projectId)
    if (!retention || retentionExpired(retention, now)) throw new BusinessError("INVALID_SOURCE", "项目保留期限已到期。")
    if (request.resultId && !input.baseVersionId) throw new BusinessError("CONFLICT", "请指定证据报告基础版本。")
    if (!request.resultId && input.baseVersionId) throw new BusinessError("INVALID_INPUT", "新建证据报告不能指定基础版本。")
    const unique = [...new Set(input.value.itemVersionIds)]
    if (unique.length !== input.value.itemVersionIds.length) throw new BusinessError("INVALID_INPUT", "证据项版本重复。")
    const items: EvidenceItem[] = []
    for (const versionId of unique) {
      const item = await this.dependencies.repository.item(projectId, versionId).catch(failure => evidenceError(failure))
      if (item.contractId && input.value.contractId && item.contractId !== input.value.contractId) throw new BusinessError("INVALID_SOURCE", "证据项不属于当前合同。")
      items.push(item)
    }
    const value = buildEvidenceReportValue({ projectId, createdBy: identity.account.id, cutoff: input.value.cutoff,
      ...(input.value.contractId ? { contractId: input.value.contractId } : {}), items,
      timeline: input.value.timeline, disputes: input.value.disputes, gaps: input.value.gaps, suggestions: input.value.suggestions })
    const sources = new Map<string, ResultSource>()
    const dependencies = new Map<string, ResultDependency>()
    for (const item of items) {
      for (const source of [...item.sources, ...item.conflicts]) {
        if (!source.fragmentId) throw new BusinessError("INVALID_SOURCE", "证据来源须定位到片段。")
        sources.set([source.parseSnapshotId, source.fragmentId, source.quote].join("|"), { snapshotId: source.parseSnapshotId, fragmentId: source.fragmentId, quote: source.quote })
        if (source.materialId && source.materialVersionId) dependencies.set(`material|${source.materialId}|${source.materialVersionId}`, { kind: "material", id: source.materialId, versionId: source.materialVersionId })
      }
      for (const link of item.links) {
        if (link.kind === "fact") dependencies.set(`fact|${link.factId}|${link.factVersionId}`, { kind: "fact", id: link.factId, versionId: link.factVersionId })
        else if (link.kind === "payment" && link.resultId) dependencies.set(`result|${link.resultId}|${link.ledgerRevisionId}`, { kind: "result", id: link.resultId, versionId: link.ledgerRevisionId })
        else if (link.kind === "dispute" && link.resultId) dependencies.set(`result|${link.resultId}|${link.evidenceReportRevisionId}`, { kind: "result", id: link.resultId, versionId: link.evidenceReportRevisionId })
      }
    }
    await this.access(identity, authorize, projectId, "edit")
    return this.dependencies.results.saveResultRevision(identity, authorize, {
      projectId, ...(request.resultId ? { resultId: request.resultId } : {}), kind: "evidence-report",
      baseVersionId: input.baseVersionId, operationId: input.operationId, reason: input.reason, value,
      sources: [...sources.values()], dependencies: [...dependencies.values()],
    }, undefined, { serverOwned: true })
  }
}
