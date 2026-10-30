import { createHash } from "node:crypto"
import type { PublishedRef } from "../../lib/business/contracts"
import {
  CHECK_CATEGORIES, SEVERITIES,
  type ReviewResult,
} from "../../../tools/contract-review/src/types"
import type { ResultValidator } from "../results/validation"

/**
 * A4c production result validator for `contract-review`.
 *
 * This is the server-owned business validator registered by
 * src/server/results/registry.ts. It is not a re-implementation of the agent's
 * own checks: it revalidates the saved immutable value from scratch —
 * structure and required fields, the input text digest, finding/citation
 * verbatim quotes, coverage/status consistency and the declared basis mode.
 * `ResultService.validation` additionally checks that every recorded source
 * fragment exists and contains the quote verbatim in the project database.
 *
 * Status policy:
 * - invalid: structural failure, digest mismatch, invalid citation, a
 *   `mode:"published"` claim without the embedded fixed publication refs (or a
 *   malformed/debug-mode publication basis), or a success claim inconsistent
 *   with the declared coverage/complete flag.
 * - partial: a genuine partial result (status partial or declared incomplete
 *   coverage). It can be saved and exported as a draft, but not approved.
 * - valid: complete coverage with no structural issues.
 *
 * C6 published mode: the executor re-reads the DB-pinned version and embeds the
 * same `PublicationRef` list in the saved value. This validator can only check
 * the embedded structure and its consistency with `mode`; it has no database
 * access, so authenticity comes from the executor's pre-save DB check (spec/01
 * §8.2.2). A bare `mode:"published"` value therefore stays invalid.
 */
const categories = new Set<string>(CHECK_CATEGORIES)
const findingKinds = new Set(["发现问题", "未发现问题", "缺失条款", "待核实"])
const severities = new Set<string>(SEVERITIES)
const coverageStatuses = new Set(["发现问题", "未发现问题", "缺失条款", "待核实", "未覆盖"])
const covered = new Set(["发现问题", "未发现问题", "缺失条款"])
type Issue = { code: string; message: string; ref?: string }

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
const body = (value: unknown): string => (typeof value === "string" ? value.trim() : "")
const digest = (paragraphs: Array<{ text: string }>) => createHash("sha256").update(paragraphs.map(item => item.text).join("\n")).digest("hex")

function checkStructure(value: unknown, issues: Issue[]) {
  const result = object(value)
  if (!result) { issues.push({ code: "INVALID_STRUCTURE", message: "审查成果不是有效对象。" }); return null }
  if (result.schemaVersion !== 1) issues.push({ code: "INVALID_STRUCTURE", message: "成果版本不受支持。" })
  if (!["success", "partial", "failed"].includes(body(result.status))) issues.push({ code: "INVALID_STRUCTURE", message: "成果执行状态无效。" })
  if (result.mode !== "debug" && result.mode !== "published") issues.push({ code: "INVALID_STRUCTURE", message: "成果模式无效。" })
  if (!body(result.documentTitle) || body(result.documentTitle).length > 200) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少有效的文档标题。" })
  if (!body(result.packVersion) || body(result.packVersion).length > 128) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少规则包版本。" })
  if (!body(result.reviewId) || body(result.reviewId).length > 128) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少审查编号。" })
  if (!Array.isArray(result.findings)) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少逐条发现。" })
  if (!Array.isArray(result.errors)) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少错误记录。" })
  if (!Array.isArray(result.warnings)) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少提示记录。" })
  if (!Number.isSafeInteger(result.callsUsed) || Number(result.callsUsed) < 0) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少调用次数记录。" })

  const input = object(result.input)
  if (!input) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少输入标识。" })
  else {
    if (typeof input.textSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.textSha256)) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少输入文字摘要。" })
    if (!body(input.parseSnapshotId) || body(input.parseSnapshotId).length > 200) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少解析快照标识。" })
    if (!body(input.documentVersionId) || body(input.documentVersionId).length > 200) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少文档版本标识。" })
    if (typeof input.complete !== "boolean") issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少输入完整性声明。" })
  }

  const paragraphs: Array<{ index: number; text: string }> = []
  if (!Array.isArray(result.paragraphs) || !result.paragraphs.length) issues.push({ code: "INVALID_STRUCTURE", message: "成果缺少审查正文段落。" })
  else {
    const indexes = new Set<number>()
    for (const item of result.paragraphs) {
      const paragraph = object(item)
      if (!paragraph || !Number.isSafeInteger(paragraph.index) || Number(paragraph.index) < 0 ||
        typeof paragraph.text !== "string" || !paragraph.text.trim() || indexes.has(Number(paragraph.index))) {
        issues.push({ code: "INVALID_STRUCTURE", message: "成果正文段落结构无效。" })
        break
      }
      indexes.add(Number(paragraph.index))
      paragraphs.push({ index: Number(paragraph.index), text: String(paragraph.text) })
    }
  }
  return { result, input, paragraphs }
}

function checkPublishedRefs(value: unknown, ref: string, issues: Issue[]): PublishedRef[] | null {
  if (!Array.isArray(value)) { issues.push({ code: "INVALID_STRUCTURE", message: "固定发布引用列表无效。", ref }); return null }
  const refs: PublishedRef[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const item = object(raw)
    if (!item || !body(item.id) || body(item.id).length > 128 || !body(item.versionId) || body(item.versionId).length > 64 ||
      typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      issues.push({ code: "INVALID_STRUCTURE", message: "固定发布引用结构无效。", ref: `${ref}[${index}]` })
      return null
    }
    const key = `${item.id}\u0000${item.versionId}`
    if (seen.has(key)) { issues.push({ code: "INVALID_STRUCTURE", message: "固定发布引用重复。", ref: `${ref}[${index}]` }); return null }
    seen.add(key)
    refs.push({ id: body(item.id), versionId: body(item.versionId), sha256: item.sha256 })
  }
  return refs
}

/**
 * Published-mode basis policy (spec/01 §8.2.2):
 * - debug: valid only without an embedded publication basis.
 * - published: valid only with the executor-embedded fixed refs; a bare mode
 *   claim, malformed refs or an empty rules list is invalid.
 */
function checkPublicationBasis(result: Record<string, unknown>, issues: Issue[]): void {
  const raw = result.publicationBasis
  if (result.mode === "debug") {
    if (raw !== undefined) issues.push({ code: "UNSIGNED_BASIS", message: "调试模式成果不得内嵌发布依据。" })
    return
  }
  if (result.mode !== "published") return
  if (raw === undefined || raw === null) {
    issues.push({ code: "UNSIGNED_BASIS", message: "已发布模式成果缺少内嵌的固定发布引用。" })
    return
  }
  const basis = object(raw)
  if (!basis) { issues.push({ code: "UNSIGNED_BASIS", message: "已发布模式成果的固定发布引用结构无效。" }); return }
  const rules = checkPublishedRefs(basis.rules, "publicationBasis.rules", issues)
  if (!rules || !rules.length) issues.push({ code: "UNSIGNED_BASIS", message: "已发布模式成果缺少规则发布引用。" })
  for (const key of ["knowledge", "templates"] as const) {
    if (basis[key] !== undefined) checkPublishedRefs(basis[key], `publicationBasis.${key}`, issues)
  }
}

function checkFindings(result: ReviewResult, paragraphs: Array<{ index: number; text: string }>, issues: Issue[]): void {
  const byIndex = new Map(paragraphs.map(item => [item.index, item.text]))
  result.findings.forEach((finding, position) => {
    const ref = `findings[${position}]`
    const item = object(finding)
    if (!item) { issues.push({ code: "INVALID_STRUCTURE", message: "发现条目结构无效。", ref }); return }
    if (!body(item.ruleId) || body(item.ruleId).length > 64) issues.push({ code: "INVALID_STRUCTURE", message: "发现条目缺少规则编号。", ref })
    if (!categories.has(body(item.category))) issues.push({ code: "INVALID_STRUCTURE", message: "发现条目的检查类别无效。", ref })
    if (!findingKinds.has(body(item.kind))) issues.push({ code: "INVALID_STRUCTURE", message: "发现条目的结论类型无效。", ref })
    if (!body(item.risk) || body(item.risk).length > 2000) issues.push({ code: "INVALID_STRUCTURE", message: "发现条目缺少风险说明。", ref })
    if (!severities.has(body(item.severity))) issues.push({ code: "INVALID_STRUCTURE", message: "发现条目的严重程度无效。", ref })
    if (typeof item.quote !== "string") issues.push({ code: "INVALID_STRUCTURE", message: "发现条目缺少引文。" , ref })
    if (!Number.isSafeInteger(item.paragraphIndex) || Number(item.paragraphIndex) < -1) issues.push({ code: "INVALID_STRUCTURE", message: "发现条目的段落位置无效。", ref })
    if (!Array.isArray(item.pending) || (item.pending as unknown[]).some(entry => typeof entry !== "string")) issues.push({ code: "INVALID_STRUCTURE", message: "发现条目的待核实项无效。", ref })
    if (!Array.isArray(item.basis) || (item.basis as unknown[]).some(entry => typeof entry !== "string")) issues.push({ code: "INVALID_STRUCTURE", message: "发现条目的依据无效。", ref })
    if (item.reviewStatus !== "待人工复核") issues.push({ code: "INVALID_STRUCTURE", message: "发现条目缺少人工复核待办标记。", ref })
    if (item.placeholder === true) {
      if (item.kind !== "待核实" || item.quote !== "" || Number(item.paragraphIndex) !== -1) issues.push({ code: "INVALID_STRUCTURE", message: "占位条目不是待核实结论。", ref })
      return
    }
    const kind = body(item.kind)
    const quote = typeof item.quote === "string" ? item.quote : ""
    const paragraphIndex = Number(item.paragraphIndex)
    if (kind === "缺失条款") {
      if (quote || paragraphIndex !== -1) issues.push({ code: "INVALID_CITATION", message: "缺失条款不得虚构引文。", ref })
      if (Array.isArray(item.citations) && item.citations.length) issues.push({ code: "INVALID_CITATION", message: "缺失条款不得附带补充引文。", ref })
    } else if (kind === "待核实" && !quote.trim()) {
      if (paragraphIndex !== -1) issues.push({ code: "INVALID_CITATION", message: "无引文的待核实条目位置应为 -1。", ref })
      if (!(item.pending as string[]).some(entry => entry.trim())) issues.push({ code: "INVALID_STRUCTURE", message: "待核实条目必须说明待补事项。", ref })
    } else {
      if (paragraphIndex < 0 || !quote.trim()) issues.push({ code: "INVALID_CITATION", message: "发现条目缺少可定位的原文引文。", ref })
      else if (!(byIndex.get(paragraphIndex) ?? "").includes(quote)) issues.push({ code: "INVALID_CITATION", message: "引文未逐字出现在所声明的正文段落中。", ref })
    }
    if (kind !== "待核实" && !(item.basis as string[]).some(entry => entry.trim())) issues.push({ code: "INVALID_STRUCTURE", message: "确定性结论必须引用依据。", ref })
    if (!Array.isArray(item.citations)) issues.push({ code: "INVALID_STRUCTURE", message: "发现条目缺少引文列表。", ref })
    else for (const [citationIndex, raw] of (item.citations as unknown[]).entries()) {
      const citation = object(raw)
      if (!citation || !Number.isSafeInteger(citation.paragraphIndex) || typeof citation.quote !== "string" || !citation.quote.trim()) {
        issues.push({ code: "INVALID_CITATION", message: "补充引文结构无效。", ref: `${ref}.citations[${citationIndex}]` })
        continue
      }
      if (!(byIndex.get(Number(citation.paragraphIndex)) ?? "").includes(String(citation.quote))) {
        issues.push({ code: "INVALID_CITATION", message: "补充引文未逐字出现在所声明的正文段落中。", ref: `${ref}.citations[${citationIndex}]` })
      }
      for (const field of ["documentVersionId", "parseSnapshotId"] as const) {
        if (citation[field] !== undefined && (typeof citation[field] !== "string" || !String(citation[field]).trim() || String(citation[field]).length > 200)) {
          issues.push({ code: "INVALID_STRUCTURE", message: "补充引文的版本标识无效。", ref: `${ref}.citations[${citationIndex}]` })
        }
      }
    }
  })
}

function checkCoverage(result: ReviewResult, complete: boolean, issues: Issue[]): { covered: boolean; partial: boolean } {
  const coverage = Array.isArray(result.coverage) ? result.coverage : []
  const seen = new Set<string>()
  for (const [index, raw] of coverage.entries()) {
    const item = object(raw)
    if (!item || !categories.has(body(item.category)) || seen.has(body(item.category)) ||
      !coverageStatuses.has(body(item.status)) || typeof item.note !== "string" || item.note.length > 500 ||
      !Array.isArray(item.findingIds) || (item.findingIds as unknown[]).some(id => typeof id !== "string")) {
      issues.push({ code: "INVALID_STRUCTURE", message: "检查覆盖记录无效。", ref: `coverage[${index}]` })
      continue
    }
    seen.add(body(item.category))
  }
  if (seen.size !== CHECK_CATEGORIES.length) issues.push({ code: "INVALID_STRUCTURE", message: "检查覆盖未包含全部六类必检项。" })
  const partialCoverage = !complete || coverage.some(item => {
    const record = object(item)
    return !record || !covered.has(body(record.status))
  })
  const definite = (result.findings ?? []).some(finding => finding.placeholder !== true && finding.kind !== "待核实")
  if (result.status === "success") {
    if (!complete) issues.push({ code: "COVERAGE_INCONSISTENT", message: "输入不完整时不能输出成功状态。" })
    if ((result.errors ?? []).length) issues.push({ code: "COVERAGE_INCONSISTENT", message: "存在错误记录时不能输出成功状态。" })
    if (partialCoverage) issues.push({ code: "COVERAGE_INCONSISTENT", message: "覆盖未完成时不能输出成功状态。" })
  }
  if (result.status === "partial" && !definite) issues.push({ code: "COVERAGE_INCONSISTENT", message: "部分完成必须有至少一条有效的检查结论。" })
  if (result.status === "failed") issues.push({ code: "RESULT_FAILED", message: "执行失败的审查不能作为可复核成果。" })
  return { covered: !partialCoverage, partial: result.status === "partial" || partialCoverage }
}

function checkFindingDecisions(result: Record<string, unknown>, issues: Issue[]): void {
  if (result.findingDecisions === undefined) return
  if (!Array.isArray(result.findingDecisions)) {
    issues.push({ code: "INVALID_DECISION", message: "发现项处理记录无效。" })
    return
  }
  const findings = Array.isArray(result.findings) ? result.findings : []
  const seen = new Set<number>()
  for (const [index, raw] of result.findingDecisions.entries()) {
    const item = object(raw)
    const ref = `findingDecisions[${index}]`
    const position = Number(item?.findingIndex)
    const finding = object(findings[position])
    if (!item || !Number.isSafeInteger(item.findingIndex) || position < 0 || !finding || seen.has(position) ||
      item.ruleId !== finding.ruleId || !["采纳", "驳回", "修订"].includes(String(item.decision)) ||
      typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 500 ||
      Object.keys(item).some(key => !["findingIndex", "ruleId", "decision", "reason", "editedSuggestion", "editedImpact"].includes(key)) ||
      (item.decision === "修订" ? typeof item.editedSuggestion !== "string" || !item.editedSuggestion.trim() || item.editedSuggestion.length > 2000 : item.editedSuggestion !== undefined) ||
      (item.editedImpact !== undefined && (typeof item.editedImpact !== "string" || !item.editedImpact.trim() || item.editedImpact.length > 500))) {
      issues.push({ code: "INVALID_DECISION", message: "发现项处理的编号、决定、理由或修订内容无效。", ref })
    }
    seen.add(position)
  }
}

export const contractReviewResultValidator: ResultValidator = async value => {
  const issues: Issue[] = []
  const shape = checkStructure(value, issues)
  if (!shape) return { status: "invalid", issues }
  const { result, input, paragraphs } = shape
  checkPublicationBasis(result, issues)
  if (input && typeof input.textSha256 === "string" && paragraphs.length) {
    if (digest(paragraphs) !== input.textSha256) issues.push({ code: "INVALID_TEXT_HASH", message: "成果输入摘要与正文不一致。" })
  }
  checkFindings(result as unknown as ReviewResult, paragraphs, issues)
  checkFindingDecisions(result, issues)
  const coverage = checkCoverage(result as unknown as ReviewResult, input?.complete === true, issues)
  if (issues.length) return { status: "invalid", issues }
  return { status: coverage.partial ? "partial" : "valid", issues }
}
