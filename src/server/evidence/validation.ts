import { EvidenceError, EVIDENCE_ITEM_KINDS, CONFIRMATION_STATUSES, EVIDENCE_SUPPORTS,
  type EvidenceItemInput, type EvidenceLink, type EvidenceReportInput, type SourceRef } from "@/lib/evidence/types"

const isoDate = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const amountFen = /^-?(?:0|[1-9]\d*)$/
const required = (value: string | undefined, field: string, max = 200) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000]/.test(value)) throw new EvidenceError("EVIDENCE_INPUT_INVALID", field + "无效。")
  return value.trim()
}
const date = (value: string, field: string) => { if (!isoDate.test(value) || Number.isNaN(Date.parse(value))) throw new EvidenceError("EVIDENCE_INPUT_INVALID", field + "不是有效日期。") }

function source(value: SourceRef, projectId: string) {
  if (value.projectId !== projectId) throw new EvidenceError("EVIDENCE_PROJECT_MISMATCH", "来源不属于当前项目。")
  required(value.parseSnapshotId, "来源快照")
  // 项目主线使用材料版本；匿名文档增量使用文档版本，二者二选一且须成对出现。
  if (value.materialVersionId) { required(value.materialId, "来源材料"); required(value.materialVersionId, "来源版本") }
  else { required(value.documentId, "来源文档"); required(value.documentVersionId, "来源版本") }
  required(value.quote, "来源引文", 2000)
  if (value.paragraphIndex === undefined && !value.fragmentId) throw new EvidenceError("EVIDENCE_INPUT_INVALID", "来源须定位到段落或片段。")
  if (value.paragraphIndex !== undefined && (!Number.isSafeInteger(value.paragraphIndex) || value.paragraphIndex < 0)) throw new EvidenceError("EVIDENCE_INPUT_INVALID", "来源段落编号无效。")
}

function link(value: EvidenceLink, projectId: string) {
  if (value.kind === "fact") { required(value.factId, "事实 ID"); required(value.factVersionId, "事实版本 ID"); return }
  if (value.kind === "payment") { required(value.ledgerRevisionId, "款项版本 ID"); required(value.rowId, "款项行 ID"); return }
  if (value.kind === "clause") { source(value.source, projectId); return }
  if (value.kind === "dispute") { required(value.evidenceReportRevisionId, "报告版本 ID"); required(value.disputeId, "争点 ID"); return }
  throw new EvidenceError("EVIDENCE_INPUT_INVALID", "未知的关联类型。")
}

export function validateEvidenceItem(input: EvidenceItemInput) {
  required(input.projectId, "项目")
  if (input.contractId !== undefined) required(input.contractId, "合同")
  if (!EVIDENCE_ITEM_KINDS.includes(input.kind)) throw new EvidenceError("EVIDENCE_INPUT_INVALID", "证据类型无效。")
  required(input.title, "标题")
  if (!CONFIRMATION_STATUSES.includes(input.confirmation)) throw new EvidenceError("EVIDENCE_INPUT_INVALID", "确认状态无效。")
  if (!EVIDENCE_SUPPORTS.includes(input.support)) throw new EvidenceError("EVIDENCE_INPUT_INVALID", "证据状态无效。")
  if (input.occurredAt !== undefined) date(input.occurredAt, "发生日期")
  if (input.period) { if (input.period.start) date(input.period.start, "起始日期"); if (input.period.end) date(input.period.end, "截止日期") }
  if (!Array.isArray(input.sources) || !Array.isArray(input.conflicts) || !Array.isArray(input.links)) throw new EvidenceError("EVIDENCE_INPUT_INVALID", "证据引用无效。")
  input.sources.forEach(value => source(value, input.projectId))
  input.conflicts.forEach(value => source(value, input.projectId))
  const seenSources = new Set<string>()
  for (const value of [...input.sources, ...input.conflicts]) {
    const key = [value.materialVersionId ?? value.documentVersionId, value.parseSnapshotId, value.paragraphIndex ?? "", value.fragmentId ?? "", value.quote].join("|")
    if (seenSources.has(key)) throw new EvidenceError("EVIDENCE_SOURCE_DUPLICATE", "同一附件与段落被重复引用。")
    seenSources.add(key)
  }
  if (input.conflicts.length && input.support !== "材料冲突") throw new EvidenceError("EVIDENCE_SUPPORT_CONFLICT", "存在冲突来源时证据状态必须为材料冲突。")
  if (input.support === "材料冲突" && !input.conflicts.length) throw new EvidenceError("EVIDENCE_SUPPORT_CONFLICT", "材料冲突须至少保留一个冲突来源。")
  if (input.support === "材料支持" && !input.sources.length) throw new EvidenceError("EVIDENCE_SUPPORT_REQUIRED", "材料支持须提供可定位来源。")
  if (input.kind === "材料事实" && input.support === "仅人工陈述") throw new EvidenceError("EVIDENCE_SUPPORT_REQUIRED", "材料事实不能仅以人工陈述为支持。")
  if (input.kind === "人工陈述" && input.support === "材料支持") throw new EvidenceError("EVIDENCE_SUPPORT_REQUIRED", "人工陈述不能标记为材料支持。")
  if (input.kind === "程序计算" && !input.links.some(value => value.kind === "fact")) throw new EvidenceError("EVIDENCE_LINK_REQUIRED", "程序计算结果须引用事实版本。")
  input.links.forEach(value => link(value, input.projectId))
  const pending = input.pendingLinks ?? []
  if (new Set(pending).size !== pending.length || pending.some(kind => !["fact", "payment", "clause", "dispute"].includes(kind)))
    throw new EvidenceError("EVIDENCE_INPUT_INVALID", "待关联类型无效或重复。")
  if (pending.some(kind => input.links.some(value => value.kind === kind))) throw new EvidenceError("EVIDENCE_INPUT_INVALID", "已建立关联的对象不能同时标记为待关联。")
  if (input.candidates) {
    if (new Set(input.candidates).size !== input.candidates.length) throw new EvidenceError("EVIDENCE_INPUT_INVALID", "候选值重复。")
    if (input.selectedValue && !input.candidates.includes(input.selectedValue) && input.selectedValue !== input.originalValue)
      throw new EvidenceError("EVIDENCE_INPUT_INVALID", "选用的值须来自候选值或原值。")
  }
  if (input.originalValue !== undefined && input.selectedValue !== undefined && input.originalValue !== input.selectedValue && !input.reason?.trim())
    throw new EvidenceError("EVIDENCE_REVISION_REASON_REQUIRED", "人工更正须保留理由。")
  required(input.createdBy, "记录人")
}

export type EvidenceScope = {
  hasDocumentSource(projectId: string, value: SourceRef): boolean | Promise<boolean>
  hasFact(projectId: string, factId: string, factVersionId: string): boolean | Promise<boolean>
  hasPayment(projectId: string, ledgerRevisionId: string, rowId: string): boolean | Promise<boolean>
  hasDispute(projectId: string, reportRevisionId: string, disputeId: string): boolean | Promise<boolean>
}

export async function assertEvidenceReferences(scope: EvidenceScope, input: EvidenceItemInput) {
  for (const value of [...input.sources, ...input.conflicts]) {
    if (!await scope.hasDocumentSource(input.projectId, value)) throw new EvidenceError("EVIDENCE_SOURCE_UNAVAILABLE", "来源不存在、版本不匹配或不属于当前项目。")
  }
  for (const value of input.links) {
    if (value.kind === "clause") { if (!await scope.hasDocumentSource(input.projectId, value.source)) throw new EvidenceError("EVIDENCE_SOURCE_UNAVAILABLE", "条款来源不可用。") }
    else if (value.kind === "fact") { if (!await scope.hasFact(input.projectId, value.factId, value.factVersionId)) throw new EvidenceError("EVIDENCE_LINK_UNAVAILABLE", "事实版本不存在或不属于当前项目。") }
    else if (value.kind === "payment") { if (!await scope.hasPayment(input.projectId, value.ledgerRevisionId, value.rowId)) throw new EvidenceError("EVIDENCE_LINK_UNAVAILABLE", "款项版本不存在或不属于当前项目。") }
    else if (value.kind === "dispute") { if (!await scope.hasDispute(input.projectId, value.evidenceReportRevisionId, value.disputeId)) throw new EvidenceError("EVIDENCE_LINK_UNAVAILABLE", "争点版本不存在或不属于当前项目。") }
  }
}

export function validateReportInput(input: EvidenceReportInput) {
  required(input.projectId, "项目")
  if (input.contractId !== undefined) required(input.contractId, "合同")
  date(input.cutoff, "核对截止日")
  required(input.createdBy, "记录人")
  const versions = new Map(input.items.map(item => [item.versionId, item]))
  for (const item of input.items) {
    validateEvidenceItem(item)
    if (item.projectId !== input.projectId) throw new EvidenceError("EVIDENCE_PROJECT_MISMATCH", "证据项不属于当前项目。")
  }
  const known = (id: string, field: string) => { if (!versions.has(id)) throw new EvidenceError("EVIDENCE_INPUT_INVALID", field + "引用了不存在的证据版本。") }
  for (const event of input.timeline) { required(event.id, "时间线 ID"); date(event.at, "时间线日期"); required(event.title, "时间线标题"); event.evidenceVersionIds.forEach(id => known(id, "时间线")) }
  for (const dispute of input.disputes) {
    required(dispute.id, "争点 ID"); required(dispute.title, "争点标题"); dispute.evidenceVersionIds.forEach(id => known(id, "争点"))
    if (dispute.claimAmountFen !== undefined && !amountFen.test(dispute.claimAmountFen)) throw new EvidenceError("EVIDENCE_AMOUNT_INVALID", "争议金额须为整数分字符串。")
  }
  for (const gap of input.gaps) { required(gap.id, "缺证项 ID"); required(gap.description, "缺证项说明", 500); if (!["开放", "已补正"].includes(gap.status)) throw new EvidenceError("EVIDENCE_INPUT_INVALID", "缺证项状态无效。") }
  for (const suggestion of input.suggestions) { required(suggestion.id, "建议 ID"); required(suggestion.text, "建议", 500); suggestion.dependsOnVersionIds.forEach(id => known(id, "建议")) }
  if (new Set(input.timeline.map(item => item.id)).size !== input.timeline.length) throw new EvidenceError("EVIDENCE_INPUT_INVALID", "时间线编号重复。")
  if (new Set(input.disputes.map(item => item.id)).size !== input.disputes.length) throw new EvidenceError("EVIDENCE_INPUT_INVALID", "争点编号重复。")
}
