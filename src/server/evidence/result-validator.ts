import type { EvidenceItem, EvidenceReportInput, EvidenceReportValue } from "@/lib/evidence/types"
import { canonicalJson, type ResultValidator } from "../results/validation"
import { composeEvidenceReport } from "./report"

/**
 * 证据报告 value 的确定性组装（第八轮项目主线）。
 *
 * 报告条目、状态与范围说明全部由所引用的证据项版本与时间线/争点/缺口派生，
 * 浏览器只提交引用与人工整理内容；服务端保存时重建一次，校验器再重建一次，
 * 两次结果必须与保存的 value 完全一致（与款项成果同一策略）。
 */
/** 去掉显式 undefined 字段：canonical JSON 不接受 undefined，保存与校验必须一致。 */
function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => compact(item)) as unknown as T
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).map(([key, item]) => [key, compact(item)])) as T
  return value
}

export function buildEvidenceReportValue(input: EvidenceReportInput): EvidenceReportValue {
  const composed = composeEvidenceReport(input)
  const { projectId: _projectId, createdBy: _createdBy, reviewStatus: _reviewStatus, ...rest } = composed
  void _projectId; void _createdBy; void _reviewStatus
  return compact({ schemaVersion: 1, ...rest }) as EvidenceReportValue
}

const valueKeys = ["schemaVersion", "cutoff", "contractId", "status", "scopeNotes", "items", "timeline", "disputes", "gaps", "suggestions"] as const
const arrayKeys = ["items", "timeline", "disputes", "gaps", "suggestions"] as const

/** 结构、词表与派生一致性校验；任何额外字段或派生差异都视为无效。 */
export function parseEvidenceReportValue(raw: unknown): EvidenceReportValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !valueKeys.includes(key as never))) return null
  if (value.schemaVersion !== 1 || typeof value.cutoff !== "string" || typeof value.contractId === "number") return null
  if (!["draft", "incomplete"].includes(String(value.status))) return null
  if (!Array.isArray(value.scopeNotes) || value.scopeNotes.some(note => typeof note !== "string" || !note.trim())) return null
  for (const key of arrayKeys) if (!Array.isArray(value[key])) return null
  const items = value.items as EvidenceItem[]
  const projectId = items[0]?.projectId
  if (typeof projectId !== "string" || !projectId.trim()) return null
  if (items.some(item => !item || typeof item !== "object" || item.projectId !== projectId)) return null
  let expected: EvidenceReportValue
  try {
    expected = buildEvidenceReportValue({
      projectId, createdBy: items[0]?.createdBy ?? "validator", cutoff: String(value.cutoff),
      ...(typeof value.contractId === "string" ? { contractId: value.contractId } : {}),
      items, timeline: value.timeline as EvidenceReportInput["timeline"], disputes: value.disputes as EvidenceReportInput["disputes"],
      gaps: value.gaps as EvidenceReportInput["gaps"], suggestions: value.suggestions as EvidenceReportInput["suggestions"],
    })
  } catch { return null }
  return canonicalJson(expected) === canonicalJson(raw) ? expected : null
}

export const evidenceReportValidator: ResultValidator = async raw => {
  const value = parseEvidenceReportValue(raw)
  if (!value) return { status: "invalid", issues: [{ code: "INVALID_EVIDENCE_REPORT", message: "证据报告结构或派生状态不一致。" }] }
  return value.status === "incomplete"
    ? { status: "partial", issues: [{ code: "EVIDENCE_INCOMPLETE", message: "报告存在材料冲突、待核实、开放缺口或待关联事项，不能批准为完整成果。" }] }
    : { status: "valid", issues: [] }
}
