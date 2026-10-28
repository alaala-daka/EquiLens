import { z } from "zod"
import type { Paragraph, ReviewResult } from "./types"

export const revisionEditSchema = z.object({
  id: z.string().min(1).max(80), operation: z.enum(["replace", "insert-after"]),
  paragraphIndex: z.number().int().min(0), before: z.string().min(1).max(10000), after: z.string().trim().min(1).max(6000),
  ruleIds: z.array(z.string().min(1).max(100)).min(1).max(22),
  valueChanges: z.array(z.object({ original: z.string().min(1).max(80), placeholder: z.string().regex(/^【待确认：[^】]+】$/) }).strict()).max(20).optional(),
}).strict()
export const revisionDecisionSchema = z.object({
  ruleId: z.string().min(1).max(100), action: z.enum(["changed", "pending", "unchanged"]),
  editIds: z.array(z.string().min(1).max(80)).max(30), reason: z.string().trim().min(1).max(300),
}).strict()
export const revisionCheckSchema = z.object({
  ruleId: z.string().min(1).max(100), outcome: z.enum(["已处理", "需确认", "存在问题"]),
  note: z.string().trim().min(1).max(400), paragraphIndex: z.number().int().min(-1), quote: z.string().max(6000),
  basis: z.array(z.string().min(1).max(100)).max(20),
}).strict()
export type RevisionEdit = z.infer<typeof revisionEditSchema>
export type RevisionDecision = z.infer<typeof revisionDecisionSchema>
export type RevisionCheck = z.infer<typeof revisionCheckSchema>
export type RevisionState = {
  id: string; primarySha256: string; inputSha256: string; skillSha256: string; sha256: string
  status: "completed" | "partial" | "failed"; edits: RevisionEdit[]; decisions: RevisionDecision[]; paragraphs: Paragraph[]
  callsUsed: number; usage: ReviewResult["usage"]; errors: { code: string; message: string }[]
  export?: { sha256: string; draftSha256: string; renderVersion: string; attempt: number; filename: string }
  strategy?: "prepared-v1"
  rejected?: { id: string; reason: string }[]
}
export type RevisionAudit = {
  draftSha256: string; primarySha256: string; status: "completed" | "partial" | "failed"
  checks: RevisionCheck[]; callsUsed: number; usage: ReviewResult["usage"]; errors: { code: string; message: string }[]
  strategy?: "prepared-v1"
}
export type RevisionRepair = {
  status: "started" | "repaired" | "failed"; originalDraft: RevisionState; originalAudit: RevisionAudit
  callsUsed: number; usage: RevisionState["usage"]; errors: RevisionState["errors"]; draft?: RevisionState; rejectionReason?: string
}

function criticalValues(text: string) {
  // 「每逾期一日」表示计算单位，不是新约定的付款期限；具体 N 日/费率仍须绑定原值。
  return text.replace(/^\s*\d+(?:\.\d+)+\s+/, "").replace(/第\s*\d+(?:\.\d+)+\s*条/g, "条款").replace(/【待确认：[^】]*】/g, "").replace(/每(?:逾期)?一(?:日|天)/g, "按日").match(/(?:百|千|万|亿)分之[一二三四五六七八九十百千万亿两零〇\d]+|\d+(?:\.\d+)?\s*(?:[%％‰]|亿元|万元|千元|百元|元|亿|万|千|日历天|工作日|个月|天|日|月|年|吨|平方米|㎡)?|[一二三四五六七八九十百千万亿两零〇]+(?:亿元|万元|千元|百元|元|日历天|工作日|个月|天|日|月|年|吨|平方米|㎡)/g)?.map(value => value.replace(/\s/g, "")) ?? []
}
export function validateRevision(primary: ReviewResult, edits: RevisionEdit[], decisions: RevisionDecision[], targets = primary.findings.map(item => item.ruleId)) {
  if (!primary.input.complete || edits.length > 30 || decisions.length > primary.findings.length) throw new Error("修订范围不完整或超过上限。")
  const ids = new Set<string>(), anchors = new Set<string>(), decisionsByRule = new Set<string>()
  for (const raw of edits) {
    const edit = revisionEditSchema.parse(raw)
    const original = primary.paragraphs.find(item => item.index === edit.paragraphIndex)
    const anchor = edit.operation + ":" + edit.paragraphIndex
    if (!original) throw new Error("修改位置不存在。")
    if (original.text !== edit.before) throw new Error("引用的原文与保存的段落不一致。")
    if (ids.has(edit.id) || anchors.has(anchor)) throw new Error("修改编号或位置与已保存修改重复。")
    if (edit.operation === "insert-after" && original.inTable) throw new Error("表格内部不能插入段落，请选择正文位置。")
    if ((edit.operation === "replace" && edit.after === edit.before) || /[\r\n\u0000-\u0008\u000b-\u001f]/.test(edit.after)) throw new Error("修改内容未变化或包含不支持的字符。")
    const originalNumber = edit.before.match(/^\s*(\d+(?:\.\d+)+)\s+/)?.[1]
    if (edit.operation === "replace" && originalNumber && edit.after.match(/^\s*(\d+(?:\.\d+)+)\s+/)?.[1] !== originalNumber) throw new Error("替换时须保留原条款编号。")
    if (new Set(edit.ruleIds).size !== edit.ruleIds.length || edit.ruleIds.some(id => !primary.findings.some(item => item.ruleId === id &&
      !item.placeholder && (item.kind === "发现问题" || item.kind === "缺失条款") && item.basis.length))) throw new Error("修改缺少有效原审查结论或依据。")
    const headings = new Set(primary.paragraphs.map(item => item.text.match(/^\s*(\d+(?:\.\d+)+)\s+/)?.[1]).filter(Boolean))
    for (const match of edit.after.matchAll(/第\s*(\d+(?:\.\d+)+)\s*条/g)) if (!headings.has(match[1]) && !edit.before.includes(match[0])) throw new Error("引用的合同条款编号不存在。")
    const beforeValues = criticalValues(edit.before), afterValues = criticalValues(edit.after)
    const changes = edit.valueChanges ?? []
    if ([...edit.after.matchAll(/【待确认：([^】]*)】/g)].some(match => criticalValues(match[1]).length > 0)) throw new Error("待确认标记不得包含未确认的具体数值。")
    if (changes.length && edit.operation !== "replace") throw new Error("原值替换仅适用于原文替换。")
    if (changes.some(change => !beforeValues.includes(change.original.replace(/\s/g, "")) || !edit.before.includes(change.original) || !edit.after.includes(change.placeholder) || afterValues.includes(change.original.replace(/\s/g, ""))) ||
      new Set(changes.map(change => change.original)).size !== changes.length || new Set(changes.map(change => change.placeholder)).size !== changes.length)
      throw new Error("关键值的原值和待确认标记对应无效。")
    const count = (values: string[], value: string) => values.filter(item => item === value).length
    if (edit.operation === "insert-after" ? afterValues.length > 0 :
      [...new Set([...beforeValues, ...afterValues])].some(value => count(afterValues, value) !== count(beforeValues, value) - changes.filter(change => change.original.replace(/\s/g, "") === value).length))
      throw new Error("关键值不能擅自增加或删除；替换原值须关联待确认标记。")
    if (/(?:法定代表人|统一社会信用代码|注册地址|开户行|银行账号|联系人|(?:甲方|乙方|承包人|分包人)[：:])/.test(edit.before + edit.after)) throw new Error("主体或联系信息须经确认，本流程不自动改写。")
    // Preserve an existing generic jurisdiction phrase without treating its newly worded
    // surrounding sentence as a new named institution. Prefix boundaries keep names
    // such as “北京市工程所在地…” subject to the normal institution check.
    const genericCourt = /(^|[，。；：、向由至])(工程所在地有管辖权的人民法院|有管辖权的人民法院)/g
    const preservedCourts = new Set([...edit.before.matchAll(genericCourt)].map(match => match[2]))
    const textForNames = edit.after.replace(genericCourt, (whole, boundary: string, court: string) => preservedCourts.has(court) ? boundary : whole)
    const names = textForNames.match(/[\p{Script=Han}A-Za-z0-9]{2,40}(?:人民法院|仲裁委员会|有限公司|有限责任公司)/gu) ?? []
    if (names.some(name => !edit.before.includes(name) && !/^(?:有管辖权的|工程所在地的|合同约定的)人民法院$/.test(name))) throw new Error("新增机构或当事人未经确认。")
    ids.add(edit.id); anchors.add(anchor)
  }
  for (const raw of decisions) {
    const decision = revisionDecisionSchema.parse(raw)
    const finding = primary.findings.find(item => item.ruleId === decision.ruleId)
    if (!finding || decisionsByRule.has(decision.ruleId) || new Set(decision.editIds).size !== decision.editIds.length) throw new Error("检查项不存在或重复。")
    if (decision.action === "changed") {
      if (!decision.editIds.length || decision.editIds.some(id => !edits.some(edit => edit.id === id && edit.ruleIds.includes(decision.ruleId))))
        throw new Error("changed须引用ruleIds包含本规则的已接受修改，不能借用其他规则的editId；无法安全修改时用pending且editIds为空数组。")
    } else {
      if (decision.editIds.length) throw new Error("pending或unchanged的editIds必须为空数组，不能附带已有修改编号。")
      if (edits.some(edit => edit.ruleIds.includes(decision.ruleId))) throw new Error("本规则已有接受的正文修改，须用changed并关联这些修改编号，不能再标pending或unchanged。")
      if (decision.action === "unchanged" && finding.kind !== "未发现问题") throw new Error("原问题必须修改或明确pending，不能标为unchanged直接略过。")
    }
    decisionsByRule.add(decision.ruleId)
  }
  return targets.every(ruleId => decisionsByRule.has(ruleId)) && edits.every(edit => edit.ruleIds.every(id => decisions.some(item =>
    item.ruleId === id && item.action === "changed" && item.editIds.includes(edit.id))))
}

export function revisedParagraphs(original: Paragraph[], edits: RevisionEdit[]): Paragraph[] {
  const result: Paragraph[] = []
  for (const paragraph of original) {
    const replacement = edits.find(edit => edit.paragraphIndex === paragraph.index && edit.operation === "replace")
    result.push({ ...structuredClone(paragraph), index: result.length, text: replacement?.after ?? paragraph.text })
    const insertion = edits.find(edit => edit.paragraphIndex === paragraph.index && edit.operation === "insert-after")
    if (insertion) result.push({ index: result.length, text: insertion.after, inTable: false })
  }
  return result
}

export function revisionQuestions(draft: RevisionState, audit?: RevisionAudit) {
  return [...new Set([
    ...draft.decisions.filter(item => item.action === "pending").map(item => item.reason),
    ...(audit?.checks.filter(item => item.outcome === "需确认").map(item => item.note) ?? []),
    ...draft.edits.flatMap(item => item.after.match(/【待确认：[^】]*】/g) ?? []),
    ...draft.edits.flatMap(item => (item.valueChanges ?? []).map(change => `原第 ${item.paragraphIndex + 1} 段原值 ${change.original}，建议改为 ${change.placeholder}，须人工确认。`)),
  ])]
}
export function canExportRevision(draft: RevisionState | undefined, audit: RevisionAudit | undefined) {
  return Boolean(draft?.status === "completed" && !draft.errors.length && audit?.status === "completed" &&
    !audit.errors.length && audit.draftSha256 === draft.sha256 && audit.primarySha256 === draft.primarySha256 &&
    audit.checks.length === draft.decisions.length && new Set(audit.checks.map(item => item.ruleId)).size === draft.decisions.length &&
    draft.decisions.every(item => audit.checks.some(check => check.ruleId === item.ruleId)) && !audit.checks.some(item => item.outcome === "存在问题"))
}
