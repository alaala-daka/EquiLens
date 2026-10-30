import type { DraftingKind } from "../templates/catalog"
import { BusinessError } from "../projects/errors"
import { inspectDraftingValue } from "./validation"
import type { DraftingValue } from "./value"

/**
 * C5 draft Word export templates (`specialty-subcontract-v1` /
 * `supplementary-agreement-v1`, spec 01 §8.2.4).
 *
 * Renders only the selected immutable result value — no database or model read.
 * The embedded rendered paragraphs are printed verbatim; the export adds the
 * provenance label, template/input/original-contract pin, the missing-field
 * list and the "待核对模板草稿" disclaimer. `blocksInvalidResult: true` blocks
 * invalid results while partial drafts stay exportable as drafts.
 */
function invalid(): never {
  throw new BusinessError("INVALID_INPUT", "导出正文无效。")
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function draftingExportParagraphs(value: unknown, expected: DraftingKind): string[] {
  const inspected = inspectDraftingValue(value, expected)
  if (!inspected.value) invalid()
  const draft: DraftingValue = inspected.value
  const lines: string[] = []
  lines.push("来源：人工拟约定输入，按固定模板确定性填充（无模型生成）。")
  lines.push(`模板：${draft.template.id} ${draft.template.version}；模板摘要：${draft.template.sha256}；模板状态：待核对（未完成领域核对）。`)
  lines.push(`拟约定输入：第 ${draft.input.version} 版；版本标识：${draft.input.versionId}；输入摘要：${draft.input.sha256}。`)
  if (draft.originalContract) {
    const original = draft.originalContract
    lines.push(`原合同：${original.title}；引用类型：${original.kind === "material" ? "本项目材料版本" : "本项目专业分包合同成果"}；标识：${original.id}；版本：${original.versionId}。`)
  }
  lines.push(`缺失字段（${draft.missing.length} 项）：`)
  if (!draft.missing.length) lines.push("无。")
  draft.missing.forEach((field, index) => {
    lines.push(`${index + 1}. 【待补充：${field.label}】（章节：${field.section}；${field.reason === "conditional" ? "条件必填" : "必填"}）`)
  })
  lines.push("—— 以下为按固定模板生成的草稿正文 ——")
  lines.push(...draft.paragraphs)
  const warnings = Array.isArray((value as { warnings?: unknown }).warnings) ? (value as { warnings: unknown[] }).warnings : []
  for (const raw of warnings) {
    const warning = record(raw)
    if (warning && text(warning.code) && text(warning.message)) lines.push(`警告：${text(warning.code)}；${text(warning.message)}`)
  }
  lines.push("声明：本文件是待核对模板生成的草稿，缺失标记与未核对状态须由专业人员补充并核对；不构成完整复核成果，不能替代法律审查。")
  return lines
}

export const specialtySubcontractExportTemplate = {
  version: "specialty-subcontract-v1",
  paragraphs: (value: unknown) => draftingExportParagraphs(value, "specialty-subcontract"),
  blocksInvalidResult: true,
  originNote: "人工拟约定输入，确定性模板填充（无模型生成）",
}

export const supplementaryAgreementExportTemplate = {
  version: "supplementary-agreement-v1",
  paragraphs: (value: unknown) => draftingExportParagraphs(value, "supplementary-agreement"),
  blocksInvalidResult: true,
  originNote: "人工拟约定输入，确定性模板填充（无模型生成）",
}
