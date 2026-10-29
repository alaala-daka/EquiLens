import type { BidVerificationValue } from "../../lib/business/verification-types"
import { VERIFICATION_FIELD_LABELS, isVerificationFieldKey } from "../../lib/business/verification-fields"
import { BusinessError } from "../projects/errors"
import { inspectVerificationValue } from "./validation"

/**
 * C4 `bid-verification-report-v1` export template (plan §4.7/§5).
 *
 * Renders only the selected immutable result value — no database, model or
 * record read. The report keeps the two independent status columns, per-item
 * requirement text and source, the manual-record metadata (source/time/
 * conditions/proof), the unresolved list and the AI/human-source disclaimers.
 * `ExportService` adds the fixed AI banner, result/version, template/render
 * version, validation/review state; `blocksInvalidResult: true` blocks invalid
 * results, while partial results stay exportable as drafts.
 */
const conclusionLabels: Record<string, string> = {
  matched: "人工查询记录匹配",
  conflict: "记录冲突",
  not_found: "未查到",
  query_failed: "查询失败",
  pending: "待人工核验",
}

function invalid(): never {
  throw new BusinessError("INVALID_INPUT", "导出正文无效。")
}

function fieldLabel(field: string): string {
  return isVerificationFieldKey(field) ? VERIFICATION_FIELD_LABELS[field] : field
}

function reportParagraphs(value: unknown): string[] {
  const inspected = inspectVerificationValue(value)
  if (!inspected.value) invalid()
  const result: BidVerificationValue = inspected.value
  const byRequirement = new Map(result.requirementSet.requirements.map(requirement => [requirement.requirementId, requirement]))
  const lines: string[] = []
  lines.push("投标材料核验报告")
  lines.push("服务端确定性比较生成的机器成果；外部真实性仅记录人工查询证据，不代表系统实时官方查询。")
  lines.push(`要求集成果：${result.requirementSet.id}`)
  lines.push(`要求集版本：${result.requirementSet.versionId}`)
  lines.push(`判定日期：${result.asOf}`)
  lines.push(`执行状态：${result.status === "success" ? "比较完成" : "部分完成（存在待确认要求）"}`)
  lines.push("两组状态独立：材料检查与外部真实性分别记录；任一组未通过或未核验均不代表通过。")
  lines.push(`材料检查汇总：满足 ${result.coverage.materialSatisfied} 项，缺失 ${result.coverage.materialMissing} 项，字段冲突 ${result.coverage.fieldConflict} 项，日期不满足 ${result.coverage.dateUnsatisfied} 项，待确认 ${result.coverage.pending} 项。`)
  lines.push(`外部真实性汇总：人工查询记录匹配 ${result.coverage.externalMatched} 项，未核验 ${result.coverage.externalUnverified} 项，其他 ${result.coverage.externalOther} 项。`)
  lines.push(`比较材料（${result.materials.length} 份）：`)
  for (const material of result.materials) {
    lines.push(`${material.materialId} / ${material.versionId} / 摘要 ${material.sha256}`)
  }
  lines.push(`逐条要求（${result.items.length} 项）：`)
  result.items.forEach((item, index) => {
    const requirement = byRequirement.get(item.requirementId)
    lines.push(`${index + 1}. ${item.requirementId} · 材料检查：${item.materialCheck} · 外部真实性：${item.externalCheck}`)
    if (requirement) {
      lines.push(`义务主体：${requirement.subject || "未标注"}；材料关系：${requirement.materialRelation || "未标注"}；性质：${requirement.nature}`)
      lines.push(`原文：${requirement.quote}`)
      lines.push(`来源：${requirement.source.snapshotId}/${requirement.source.fragmentId}；材料版本：${requirement.materialVersionId}`)
      lines.push(`补遗状态：${requirement.addendumState === "none" ? "无冲突" : requirement.addendumState === "conflict" ? "补遗冲突，待人工确认" : "已按补遗修订"}`)
      if (requirement.field || requirement.group) {
        const expressions = requirement.group
          ? requirement.group.conditions.map(condition => `${fieldLabel(condition.field)} ${condition.operator} ${Array.isArray(condition.value) ? condition.value.join("、") : condition.value}`).join(` ${requirement.group.operator === "and" ? "且" : "或"} `)
          : `${fieldLabel(String(requirement.field))} ${requirement.operator ?? ""} ${Array.isArray(requirement.value) ? requirement.value.join("、") : requirement.value ?? (requirement.asOfRule === "task_as_of" ? `判定日期 ${result.asOf}` : "")}`
        lines.push(`比较条件：${expressions}`)
      }
    }
    lines.push(`判定说明：${item.detail}`)
    if (item.evidence.length) {
      const evidence = item.evidence.map(entry =>
        `${fieldLabel(entry.fieldKey)}=${entry.valueText}（${entry.origin}${entry.confidence === null ? "" : `，置信度 ${entry.confidence}`}，${entry.subjectKey}）`)
      lines.push(`证据：${evidence.join("；")}`)
    } else {
      lines.push("证据：无可用于比较的材料字段")
    }
  })
  lines.push(`外部核验记录（${result.records.length} 条）：`)
  if (!result.records.length) lines.push("无人工外部核验记录。")
  result.records.forEach((record, index) => {
    lines.push(`${index + 1}. ${record.recordId} · ${conclusionLabels[record.conclusion] ?? record.conclusion} · 要求 ${record.requirementId}`)
    lines.push(`查询主体：${record.subject}；证号：${record.certificateNo}`)
    lines.push(`来源：${record.source}；查询时间：${record.queriedAt}`)
    lines.push(`查询条件：${record.queryConditions}；证明材料版本：${record.proofMaterialVersionId}；记录摘要：${record.sha256}`)
  })
  lines.push(`未完成事项（${result.unfinished.length} 项）：`)
  if (!result.unfinished.length) lines.push("无。")
  for (const item of result.unfinished) lines.push(`${item.requirementId}：${item.reason}`)
  for (const error of result.errors) lines.push(`错误：${error.code}；${error.message}`)
  for (const warning of result.warnings) lines.push(`提示：${warning}`)
  lines.push("结论声明：本报告仅记录材料一致性比较与人工外部核验证据，外部未核验、未查到、查询失败均不构成真实性通过；不代表投标人资格真实或材料齐全，不能替代资格审核。")
  return lines
}

export const bidVerificationReportTemplate = {
  version: "bid-verification-report-v1",
  paragraphs: reportParagraphs,
  // Invalid machine results stay readable/reviewable in the UI but must not be
  // exported; partial results remain exportable as drafts (spec 01 §8.2.3).
  blocksInvalidResult: true,
  // The comparison is deterministic (no model generation); do not label it as AI output.
  originNote: "确定性比较结果（无模型生成；依据材料字段与人工核验记录）",
}
