import { z } from "zod"
import type { DocumentExtraction } from "../../lib/document-agent/types"

export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + "T00:00:00Z")
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
})
const planText = (max: number) => z.string().trim().max(max).refine(value => !/[\x00-\x1f]/.test(value))
export const letterPlanSchema = z.object({ sender: planText(100), recipient: planText(100), contractTitle: planText(200), demand: planText(300).refine(value => !/(?:[\d一二三四五六七八九十百千万亿]+[\s,.，]*(?:元|万元|亿元)|利息|违约金|账号|账户)/.test(value)),
  plannedDate: daySchema, method: planText(100), address: planText(200) }).strict()
const text = (max = 300) => z.string().min(1).max(max).refine(value => Boolean(value.trim()))
const citation = z.object({ paragraphIndex: z.number().int().min(0), quote: text(1000) }).strict()
export const extractionSchema: z.ZodType<DocumentExtraction> = z.object({ overview: text(120), coverage: z.enum(["完整", "部分"]), paymentCoverage: z.boolean(),
  amounts: z.array(z.object({ label: text(80), kind: z.enum(["计量", "计付基数", "净应付", "付款", "扣项", "未到期", "争议", "材料余额"]),
    amountYuan: z.string().regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,2})?$/), rawAmount: text(100), source: citation,
    payer: text(100).nullable(), payee: text(100).nullable(), scope: text(100), taxBasis: z.enum(["含税", "不含税", "不明"]),
    basis: z.enum(["本期", "累计", "不明"]), periodStart: daySchema.nullable(), periodEnd: daySchema.nullable(), eventDate: daySchema.nullable(),
    dueDate: daySchema.nullable(), dueEvidence: citation.nullable(), conditionMet: z.boolean().nullable(),
    ratio: z.string().regex(/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/).nullable(), rawRatio: text(50).nullable(), ratioEvidence: citation.nullable(),
  }).strict()).max(20),
  terms: z.array(z.object({ title: text(80), detail: text(), sources: z.array(citation).min(1).max(3) }).strict()).max(8),
  events: z.array(z.object({ title: text(80), date: daySchema.nullable(), detail: text(), nature: z.enum(["材料记载", "经办人陈述", "拟约定"]),
    support: z.enum(["材料支持", "材料冲突", "支持不足"]), sources: z.array(citation).min(1).max(3), conflicts: z.array(citation).max(3),
  }).strict()).max(20),
  disputes: z.array(z.object({ title: text(80), detail: text(), eventIndexes: z.array(z.number().int().min(0)).max(20) }).strict()).max(8), gaps: z.array(text(180)).max(8), notes: z.array(text(180)).max(4).optional(),
}).strict()
export const auditSchema = z.object({ checks: z.array(z.object({ id: text(50), accepted: z.boolean(), reason: text(160) }).strict()).min(1).max(60), gaps: z.array(text(180)).max(8), notes: z.array(text(180)).max(4).optional() }).strict()
