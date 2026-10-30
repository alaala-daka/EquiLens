import { FactError, type FactInput, type SourceAnchor } from "@/lib/facts/types"

const date = /^\d{4}-\d{2}-\d{2}$/
const required = (value: string | undefined, field: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new FactError("FACT_INPUT_INVALID", field + "无效。")
  return value.trim()
}
const checkDate = (value: string | undefined, field: string) => { if (value !== undefined && (!date.test(value) || Number.isNaN(Date.parse(value + "T00:00:00Z")))) throw new FactError("FACT_INPUT_INVALID", field + "无效。") }
function source(value: SourceAnchor, projectId: string) {
  if (value.projectId !== projectId) throw new FactError("FACT_PROJECT_MISMATCH", "来源不属于当前项目。")
  required(value.parseSnapshotId, "来源快照")
  if (value.materialId || value.materialVersionId) {
    required(value.materialId, "来源材料"); required(value.materialVersionId, "来源版本")
  } else {
    required(value.documentId, "来源文档"); required(value.documentVersionId, "来源版本")
  }
  if (typeof value.quote !== "string" || !value.quote.trim() || value.quote.length > 10000) throw new FactError("FACT_INPUT_INVALID", "来源引文无效。")
  if (value.paragraphIndex === undefined && !value.fragmentId) throw new FactError("FACT_INPUT_INVALID", "来源须定位到段落或片段。")
  if (value.paragraphIndex !== undefined && (!Number.isSafeInteger(value.paragraphIndex) || value.paragraphIndex < 0)) throw new FactError("FACT_INPUT_INVALID", "来源段落无效。")
}

export function validateFact(input: FactInput) {
  required(input.projectId, "项目")
  if (input.contractId !== undefined) required(input.contractId, "合同")
  required(input.field, "字段")
  required(input.createdBy, "记录人")
  if (!["材料记载", "人工陈述", "拟约定", "程序计算"].includes(input.nature)) throw new FactError("FACT_INPUT_INVALID", "事实性质无效。")
  if (!["未确认", "已确认", "待核实"].includes(input.confirmation)) throw new FactError("FACT_INPUT_INVALID", "确认状态无效。")
  if (!["材料支持", "仅人工陈述", "材料冲突", "缺少支持"].includes(input.support)) throw new FactError("FACT_INPUT_INVALID", "证据状态无效。")
  checkDate(input.occurredAt, "发生日期"); checkDate(input.periodStart, "起始日期"); checkDate(input.periodEnd, "截止日期")
  if (input.periodStart && input.periodEnd && input.periodStart > input.periodEnd) throw new FactError("FACT_INPUT_INVALID", "统计区间无效。")
  input.sources.forEach(value => source(value, input.projectId))
  input.conflicts.forEach(value => source(value, input.projectId))
  const seen = new Set<string>()
  for (const value of [...input.sources, ...input.conflicts]) {
    const key = [value.materialVersionId ?? value.documentVersionId, value.parseSnapshotId, value.paragraphIndex ?? "", value.fragmentId ?? "", value.quote].join("|")
    if (seen.has(key)) throw new FactError("FACT_SOURCE_DUPLICATE", "同一来源被重复引用。")
    seen.add(key)
  }
  if (input.conflicts.length && input.support !== "材料冲突") throw new FactError("FACT_SUPPORT_CONFLICT", "存在冲突来源时证据状态必须为材料冲突。")
  if (input.support === "材料冲突" && !input.conflicts.length) throw new FactError("FACT_SUPPORT_CONFLICT", "材料冲突须保留冲突来源。")
  if (input.support === "材料支持" && !input.sources.length) throw new FactError("FACT_SUPPORT_REQUIRED", "材料支持须提供来源。")
  if (input.nature === "人工陈述" && input.support === "材料支持") throw new FactError("FACT_SUPPORT_REQUIRED", "人工陈述不能标记为材料支持。")
  if (input.nature === "材料记载" && input.support === "仅人工陈述") throw new FactError("FACT_SUPPORT_REQUIRED", "材料记载不能仅以人工陈述为支持。")
  if (input.candidates) {
    if (new Set(input.candidates).size !== input.candidates.length) throw new FactError("FACT_INPUT_INVALID", "候选值重复。")
    if (input.selectedValue && !input.candidates.includes(input.selectedValue) && input.selectedValue !== input.originalValue)
      throw new FactError("FACT_INPUT_INVALID", "选用值须来自候选值或原值。")
  }
  if (input.originalValue !== undefined && input.selectedValue !== undefined && input.originalValue !== input.selectedValue && !input.reason?.trim())
    throw new FactError("FACT_REVISION_REASON_REQUIRED", "人工更正须填写理由。")
}
