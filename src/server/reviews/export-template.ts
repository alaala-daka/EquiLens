import { CHECK_CATEGORIES, SEVERITIES } from "../../../tools/contract-review/src/types"
import type { FindingDecision } from "../../lib/business/contracts"
import { BusinessError } from "../projects/errors"

/**
 * A4c `contract-review-report-v1` export template.
 *
 * Renders only the selected immutable result value — no database or model
 * access. ExportService adds the fixed AI banner, result/version, template and
 * render versions, validation/review state and unresolved issue markers; this
 * template owns the report body: coverage,每一条 finding with 位置/原文/依据,
 * unresolved items and the unsigned-basis disclaimer.
 */
const findingsLabel: Record<string, string> = { "发现问题": "发现问题", "未发现问题": "未发现问题", "缺失条款": "缺失条款", "待核实": "待核实" }

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : []
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function invalid(): never {
  throw new BusinessError("INVALID_INPUT", "导出正文无效。")
}

/** Plain paragraphs only; ExportService splits multi-line strings itself. */
function reportParagraphs(value: unknown): string[] {
  const result = record(value)
  if (!result || result.schemaVersion !== 1 || !Array.isArray(result.findings) || !Array.isArray(result.coverage)) invalid()
  const input = record(result.input)
  if (!input) invalid()
  const context = record(input.context) ?? {}
  const lines: string[] = []
  lines.push("项目合同审查报告")
  lines.push("AI 辅助生成的机器成果，依据尚未签核，须由专业人员复核。")
  lines.push(`文档标题：${text(result.documentTitle) || "未命名材料"}`)
  lines.push(`执行状态：${["success", "partial", "failed"].includes(text(result.status)) ? text(result.status) : "未知"}`)
  lines.push(`审查模式：${result.mode === "debug" ? "开发调试，依据未核对" : "已发布规则"}`)
  lines.push(`规则包版本：${text(result.packVersion) || "未标注"}`)
  lines.push(`审查场景：${text(context.scene) || "未标注"}；立场：${text(context.role) || "未标注"}；地域：${text(context.region) || "未标注"}`)
  lines.push(`输入完整性：${input.complete === true ? "调用方声明完整" : "不完整（存在解析或阅读范围限制）"}`)
  const summary = record(result.summary)
  const issues = Number(summary?.issues ?? (result.findings as { kind?: unknown }[]).filter(item => ["发现问题", "缺失条款"].includes(String(item?.kind))).length)
  const pending = Number(summary?.pending ?? (result.findings as { kind?: unknown }[]).filter(item => item?.kind === "待核实").length)
  lines.push(`结果摘要：发现/缺失 ${Number.isFinite(issues) ? issues : 0} 项，待核实 ${Number.isFinite(pending) ? pending : 0} 项，未采用 ${(result.rejected as unknown[] | undefined)?.length ?? 0} 项。`)
  lines.push("检查覆盖：")
  for (const raw of result.coverage as unknown[]) {
    const item = record(raw)
    if (!item) continue
    const category = CHECK_CATEGORIES.includes(item.category as never) ? String(item.category) : "未登记类别"
    lines.push(`${category}：${text(item.status) || "未标注"}${text(item.note) ? `（${text(item.note)}）` : ""}`)
  }
  const findings = result.findings as unknown[]
  lines.push(`逐条发现（${findings.length} 项）：`)
  findings.forEach((raw, index) => {
    const finding = record(raw)
    if (!finding) return
    const kindLabel = findingsLabel[text(finding.kind)]
    const kind = kindLabel ?? (text(finding.kind) || "未标注")
    const severity = SEVERITIES.includes(finding.severity as never) ? String(finding.severity) : text(finding.severity) || "未标注"
    lines.push(`${index + 1}. ${text(finding.category) || "未登记类别"} · ${kind} · ${severity} · ${text(finding.ruleId) || "未标注规则"}`)
    if (text(finding.risk)) lines.push(`问题：${text(finding.risk)}`)
    if (finding.kind === "缺失条款") lines.push("位置：所声明的完整检查范围，未找到必要约定。")
    else if (Number.isSafeInteger(finding.paragraphIndex) && Number(finding.paragraphIndex) >= 0) {
      lines.push(`位置：第 ${Number(finding.paragraphIndex) + 1} 段（合并材料段落定位）；原文：${text(finding.quote) || "未提供"}`)
    }
    for (const citationRaw of Array.isArray(finding.citations) ? finding.citations : []) {
      const citation = record(citationRaw)
      if (!citation || !Number.isSafeInteger(citation.paragraphIndex) || citation.paragraphIndex === finding.paragraphIndex) continue
      if (!text(citation.quote)) continue
      lines.push(`补充引文（第 ${Number(citation.paragraphIndex) + 1} 段）：${text(citation.quote)}`)
    }
    const references = Array.isArray(finding.sourceReferences)
      ? (finding.sourceReferences as unknown[]).map(rawReference => {
        const reference = record(rawReference)
        if (!reference) return ""
        return [text(reference.sourceId), text(reference.type), text(reference.name), text(reference.article), text(reference.version), text(reference.status)].filter(Boolean).join(" ")
      }).filter(Boolean)
      : []
    const basis = strings(finding.basis)
    lines.push(`依据：${references.length ? references.join("；") : basis.length ? basis.join("、") : "未提供（待人工复核）"}`)
    if (text(finding.impact)) lines.push(`影响：${text(finding.impact)}`)
    if (text(finding.suggestion)) lines.push(`建议：${text(finding.suggestion)}`)
    const pendingItems = strings(finding.pending)
    if (pendingItems.length) lines.push(`待核实：${pendingItems.join("；")}`)
    lines.push(`复核状态：${text(finding.reviewStatus) || "待人工复核"}`)
  })
  const rejected = Array.isArray(result.rejected) ? result.rejected as unknown[] : []
  if (rejected.length) {
    lines.push(`未采用的机器回答（${rejected.length} 项）：`)
    for (const raw of rejected) {
      const item = record(raw)
      if (item) lines.push(`${text(item.ruleId) || "未标注规则"}：${text(item.reason) || "未采用"}${text(item.detail) ? `；${text(item.detail)}` : ""}`)
    }
  }
  const notLocated = Array.isArray(result.notLocated) ? result.notLocated as unknown[] : []
  if (notLocated.length) {
    lines.push(`未完成的检查项（${notLocated.length} 项）：`)
    for (const raw of notLocated) {
      const item = record(raw)
      if (item) lines.push(`${text(item.ruleId) || "未标注规则"}：${item.reason === "outline-only" ? "仅有目录，待核实" : "未执行" }${text(item.detail) ? `；${text(item.detail)}` : ""}`)
    }
  }
  for (const error of Array.isArray(result.errors) ? result.errors as unknown[] : []) {
    const item = record(error)
    if (item) lines.push(`错误：${text(item.code) || "未知错误"}；${text(item.message) || "未提供说明"}`)
  }
  for (const warning of strings(result.warnings)) lines.push(`提示：${warning}`)
  lines.push("结论声明：本报告为机器辅助成果，依据未签核，覆盖与未完成项如上；不代表合同没有风险，不能替代专业审查。")
  return lines
}

export const contractReviewReportTemplate = {
  version: "contract-review-report-v1",
  paragraphs: reportParagraphs,
  // Invalid machine results are readable and reviewable, but must not produce a
  // downloadable report (spec 01 §8.2.2); partial results stay exportable as drafts.
  blocksInvalidResult: true,
}

/** Adds human processing without rewriting the original machine report. */
export const contractReviewReportTemplateV2 = {
  version: "contract-review-report-v2",
  blocksInvalidResult: true,
  paragraphs(value: unknown): string[] {
    const lines = contractReviewReportTemplate.paragraphs(value)
    const result = record(value)!
    const decisions = (result.findingDecisions ?? []) as FindingDecision[]
    lines.push("发现项人工处理：")
    const findings = result.findings as Array<{ ruleId: string }>
    findings.forEach((finding, index) => {
      const decision = decisions.find(item => item.findingIndex === index)
      lines.push(`${index + 1}. ${finding.ruleId}：${decision?.decision ?? "未处理"}`)
      if (!decision) return
      lines.push(`处理理由：${decision.reason}`)
      if (decision.editedSuggestion) lines.push(`人工修订建议：${decision.editedSuggestion}`)
      if (decision.editedImpact) lines.push(`人工修订影响：${decision.editedImpact}`)
    })
    return lines
  },
}

