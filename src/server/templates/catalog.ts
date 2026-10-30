import { createHash } from "node:crypto"
import { canonicalJson } from "../results/validation"

/**
 * C5 code-versioned drafting template catalogue.
 *
 * Templates are fixed code constants (id / version / sha / sections / clauses /
 * required & conditional-required fields / labels / source gates). There is no
 * template publication table this round and the status is permanently
 * "待核对": a template rendered from this catalogue can only produce a partial
 * draft, never an approvable complete review result (spec 01 §4.4/§8.2.4).
 *
 * The sha256 is derived from the canonical template definition (without the
 * digest itself) and re-checked by the result validators, so a value that
 * claims another template/sha is invalid. Clause text is fixed product copy;
 * `{fieldId}` placeholders are the only place user input is inserted. Missing
 * placeholders render as `【待补充：标签】` — never a fabricated value.
 */
export type DraftingKind = "specialty-subcontract" | "supplementary-agreement"
export type DraftingTemplateId = "specialty-subcontract-v1" | "supplementary-agreement-v1"
export type DraftingFieldKind = "text" | "amount" | "date" | "choice"
export type DraftingFieldSource = "proposed"

export type DraftingConditionalRequirement = { fieldId: string; equals: string }
export type DraftingFieldRequirement = "always" | { when: DraftingConditionalRequirement }

export type DraftingField = {
  id: string
  label: string
  section: string
  kind: DraftingFieldKind
  required: DraftingFieldRequirement
  source: DraftingFieldSource
  maxLength: number
  /** Fixed choices for `kind: "choice"`; the value must be one of these ids. */
  choices?: ReadonlyArray<{ value: string; label: string }>
}

export type DraftingClause = { text: string; when?: DraftingConditionalRequirement }
export type DraftingSection = { id: string; title: string; clauses: readonly DraftingClause[] }

export type DraftingOriginalContractRule = {
  required: true
  /** Allowed pinned original-contract sources: a project material version or a saved specialty-subcontract result version. */
  allowed: ReadonlyArray<{ kind: "material" | "result"; resultKind?: DraftingKind }>
}

export type DraftingTemplateDefinition = {
  id: DraftingTemplateId
  kind: DraftingKind
  version: "v1"
  status: "待核对"
  label: string
  summary: string
  sections: readonly DraftingSection[]
  fields: readonly DraftingField[]
  originalContract: DraftingOriginalContractRule | null
}

export type DraftingTemplate = DraftingTemplateDefinition & { sha256: string }

export const DRAFTING_RENDER_VERSION = "drafting-render-v1"
export const TEMPLATE_UNREVIEWED_CODE = "TEMPLATE_UNREVIEWED"
export const TEMPLATE_UNREVIEWED_WARNING = "模板状态为待核对：本文件只是确定性填充的草稿，未完成领域核对，不能批准为完整复核成果。"
export const MISSING_PREFIX = "【待补充："

const TEMPLATE_STATUS = "待核对" as const
const MAX_TEXT = 500
const MAX_MULTILINE = 2000

const choice = (...entries: Array<[string, string]>) => entries.map(([value, label]) => ({ value, label }))

const specialty: DraftingTemplateDefinition = {
  id: "specialty-subcontract-v1",
  kind: "specialty-subcontract",
  version: "v1",
  status: TEMPLATE_STATUS,
  label: "专业分包合同",
  summary: "房建机电安装专业分包合同草稿；由拟约定输入按固定模板确定性填充。",
  sections: [
    {
      id: "project", title: "项目与地点", clauses: [
        { text: "项目名称：{project.name}；项目地点：{project.location}。" },
        { text: "发包人与承包人经协商，就本专业分包工程的施工事项订立本合同，共同遵守。" },
      ],
    },
    {
      id: "parties", title: "双方主体", clauses: [
        { text: "发包人（甲方）：{parties.employer}。" },
        { text: "承包人（乙方，专业分包人）：{parties.contractor}。" },
      ],
    },
    {
      id: "scope", title: "工程范围", clauses: [
        { text: "分包工程范围：{scope.description}。" },
        { text: "承包人应按合同约定完成上述范围内的施工、配合与保修工作。" },
      ],
    },
    {
      id: "pricing", title: "计价与价款", clauses: [
        { text: "计价方式：{pricing.mode}；合同价款（人民币元）：{pricing.amount}。" },
        { text: "单价计价约定：{pricing.unitRule}。", when: { fieldId: "pricing.mode", equals: "unit_price" } },
      ],
    },
    {
      id: "payment", title: "付款条件", clauses: [
        { text: "付款条件：{payment.terms}。" },
        { text: "是否约定预付款：{payment.hasPrepayment}。" },
        { text: "预付款比例：{payment.prepayRatio}。", when: { fieldId: "payment.hasPrepayment", equals: "yes" } },
      ],
    },
    {
      id: "duration", title: "工期", clauses: [
        { text: "计划开工日期：{duration.startDate}；计划竣工日期：{duration.endDate}；合同工期：{duration.days}。" },
      ],
    },
    {
      id: "quality", title: "质量与验收", clauses: [
        { text: "质量标准：{quality.standard}。" },
        { text: "验收方式：{quality.acceptance}。" },
      ],
    },
    {
      id: "dispute", title: "争议约定", clauses: [
        { text: "争议解决方式：{dispute.method}；争议解决机构或地点：{dispute.seat}。" },
      ],
    },
    {
      id: "signature", title: "拟定签署", clauses: [
        { text: "拟签署日期：{signature.date}。" },
        { text: "本文件由系统按固定模板与人工拟约定输入确定性填充生成；模板未经领域核对，缺失字段保留【待补充】标记，签署前须由专业人员核对完整合同文本。" },
      ],
    },
  ],
  fields: [
    { id: "project.name", label: "项目名称", section: "project", kind: "text", required: "always", source: "proposed", maxLength: 200 },
    { id: "project.location", label: "项目地点", section: "project", kind: "text", required: "always", source: "proposed", maxLength: 200 },
    { id: "parties.employer", label: "发包人（甲方）名称", section: "parties", kind: "text", required: "always", source: "proposed", maxLength: 200 },
    { id: "parties.contractor", label: "承包人（乙方）名称", section: "parties", kind: "text", required: "always", source: "proposed", maxLength: 200 },
    { id: "scope.description", label: "分包工程范围", section: "scope", kind: "text", required: "always", source: "proposed", maxLength: MAX_MULTILINE },
    {
      id: "pricing.mode", label: "计价方式", section: "pricing", kind: "choice", required: "always", source: "proposed", maxLength: 32,
      choices: choice(["fixed_total", "固定总价"], ["unit_price", "单价计价"], ["other", "其他方式"]),
    },
    { id: "pricing.amount", label: "合同价款（元）", section: "pricing", kind: "amount", required: "always", source: "proposed", maxLength: 24 },
    { id: "pricing.unitRule", label: "单价计价规则", section: "pricing", kind: "text", required: { when: { fieldId: "pricing.mode", equals: "unit_price" } }, source: "proposed", maxLength: MAX_TEXT },
    { id: "payment.terms", label: "付款条件", section: "payment", kind: "text", required: "always", source: "proposed", maxLength: MAX_MULTILINE },
    {
      id: "payment.hasPrepayment", label: "是否约定预付款", section: "payment", kind: "choice", required: "always", source: "proposed", maxLength: 8,
      choices: choice(["yes", "是"], ["no", "否"]),
    },
    { id: "payment.prepayRatio", label: "预付款比例", section: "payment", kind: "text", required: { when: { fieldId: "payment.hasPrepayment", equals: "yes" } }, source: "proposed", maxLength: 100 },
    { id: "duration.startDate", label: "计划开工日期", section: "duration", kind: "date", required: "always", source: "proposed", maxLength: 10 },
    { id: "duration.endDate", label: "计划竣工日期", section: "duration", kind: "date", required: "always", source: "proposed", maxLength: 10 },
    { id: "duration.days", label: "合同工期", section: "duration", kind: "text", required: "always", source: "proposed", maxLength: 100 },
    { id: "quality.standard", label: "质量标准", section: "quality", kind: "text", required: "always", source: "proposed", maxLength: MAX_TEXT },
    { id: "quality.acceptance", label: "验收方式", section: "quality", kind: "text", required: "always", source: "proposed", maxLength: MAX_TEXT },
    {
      id: "dispute.method", label: "争议解决方式", section: "dispute", kind: "choice", required: "always", source: "proposed", maxLength: 32,
      choices: choice(["arbitration", "仲裁"], ["litigation", "诉讼"]),
    },
    { id: "dispute.seat", label: "争议解决机构或地点", section: "dispute", kind: "text", required: "always", source: "proposed", maxLength: 200 },
    { id: "signature.date", label: "拟签署日期", section: "signature", kind: "date", required: "always", source: "proposed", maxLength: 10 },
  ],
  originalContract: null,
}

const supplementary: DraftingTemplateDefinition = {
  id: "supplementary-agreement-v1",
  kind: "supplementary-agreement",
  version: "v1",
  status: TEMPLATE_STATUS,
  label: "补充协议",
  summary: "对已保存原合同版本作有限变更的补充协议草稿；必须固定本项目原合同版本。",
  sections: [
    {
      id: "original", title: "原合同", clauses: [
        { text: "原合同：{originalContract.title}；原合同版本：{originalContract.versionId}。" },
        { text: "发包人（甲方）：{parties.employer}；承包人（乙方，专业分包人）：{parties.contractor}。" },
      ],
    },
    {
      id: "change", title: "变更条款与内容", clauses: [
        { text: "变更类型：{change.kind}；变更所涉条款或事项：{change.clause}。" },
        { text: "拟变更内容：{change.content}。" },
        { text: "拟变更金额（人民币元）：{change.deltaAmount}。", when: { fieldId: "change.kind", equals: "payment" } },
      ],
    },
    {
      id: "effect", title: "生效约定", clauses: [
        { text: "生效约定：{effect.condition}。" },
        { text: "本补充协议与原合同不一致的，以本补充协议约定为准；本补充协议未变更部分继续按原合同履行。" },
      ],
    },
    {
      id: "signature", title: "拟定签署", clauses: [
        { text: "拟签署日期：{signature.date}。" },
        { text: "本文件由系统按固定模板与人工拟约定输入确定性填充生成；模板未经领域核对，缺失字段保留【待补充】标记，签署前须由专业人员核对完整文本。" },
      ],
    },
  ],
  fields: [
    { id: "parties.employer", label: "发包人（甲方）名称", section: "original", kind: "text", required: "always", source: "proposed", maxLength: 200 },
    { id: "parties.contractor", label: "承包人（乙方）名称", section: "original", kind: "text", required: "always", source: "proposed", maxLength: 200 },
    {
      id: "change.kind", label: "变更类型", section: "change", kind: "choice", required: "always", source: "proposed", maxLength: 32,
      choices: choice(["payment", "付款安排"], ["performance", "履约安排"], ["other", "其他变更"]),
    },
    { id: "change.clause", label: "变更所涉条款或事项", section: "change", kind: "text", required: "always", source: "proposed", maxLength: MAX_TEXT },
    { id: "change.content", label: "拟变更内容", section: "change", kind: "text", required: "always", source: "proposed", maxLength: MAX_MULTILINE },
    { id: "change.deltaAmount", label: "拟变更金额（元）", section: "change", kind: "amount", required: { when: { fieldId: "change.kind", equals: "payment" } }, source: "proposed", maxLength: 24 },
    { id: "effect.condition", label: "生效约定", section: "effect", kind: "text", required: "always", source: "proposed", maxLength: MAX_TEXT },
    { id: "signature.date", label: "拟签署日期", section: "signature", kind: "date", required: "always", source: "proposed", maxLength: 10 },
  ],
  originalContract: { required: true, allowed: [{ kind: "material" }, { kind: "result", resultKind: "specialty-subcontract" }] },
}

export const draftingTemplateDefinitions: readonly DraftingTemplateDefinition[] = [specialty, supplementary]

function digest(definition: DraftingTemplateDefinition): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex")
}

export const draftingTemplates: readonly DraftingTemplate[] = draftingTemplateDefinitions.map(definition => ({
  ...definition,
  sha256: digest(definition),
}))

/** Public template projection exposed to the drafting client (no server paths or internals). */
export type DraftingTemplateView = {
  id: DraftingTemplateId
  kind: DraftingKind
  version: string
  sha256: string
  status: "待核对"
  label: string
  summary: string
  sections: ReadonlyArray<{ id: string; title: string }>
  fields: DraftingField[]
  originalContract: DraftingOriginalContractRule | null
  renderVersion: string
}

export function draftingTemplateView(template: DraftingTemplate): DraftingTemplateView {
  return {
    id: template.id,
    kind: template.kind,
    version: template.version,
    sha256: template.sha256,
    status: template.status,
    label: template.label,
    summary: template.summary,
    sections: template.sections.map(section => ({ id: section.id, title: section.title })),
    fields: template.fields.map(field => ({ ...field, ...(field.choices ? { choices: field.choices.map(item => ({ ...item })) } : {}) })),
    originalContract: template.originalContract,
    renderVersion: DRAFTING_RENDER_VERSION,
  }
}

export function templateViews(): DraftingTemplateView[] {
  return draftingTemplates.map(draftingTemplateView)
}

export function draftingTemplateById(id: unknown): DraftingTemplate | null {
  if (typeof id !== "string") return null
  return draftingTemplates.find(template => template.id === id) ?? null
}

export function draftingTemplateForKind(kind: unknown): DraftingTemplate | null {
  if (typeof kind !== "string") return null
  return draftingTemplates.find(template => template.kind === kind) ?? null
}

/** Amounts are exact decimal yuan strings; floats, commas, units and exponents are rejected. */
const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export function isDraftingAmount(value: string): boolean {
  return AMOUNT_PATTERN.test(value)
}

export function isDraftingDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value)
  if (!match) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Validate one provided (non-empty) field value; returns a fixed failure message or null. */
export function draftingFieldValueError(field: DraftingField, value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return "字段值为空。"
  if (trimmed.length > field.maxLength) return "字段值超过长度上限。"
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return "字段值含控制字符。"
  if (field.kind === "amount" && !isDraftingAmount(trimmed)) return "金额必须是不超过两位小数的十进制元字符串。"
  if (field.kind === "date" && !isDraftingDate(trimmed)) return "日期必须是有效的 YYYY-MM-DD。"
  if (field.kind === "choice" && !(field.choices ?? []).some(item => item.value === trimmed)) return "选项值不在模板允许范围内。"
  return null
}

export function conditionActive(template: DraftingTemplate, condition: DraftingConditionalRequirement, values: Record<string, string>): boolean {
  return (values[condition.fieldId] ?? "").trim() === condition.equals
}

/** Required fields (including conditional requirements that are currently active) without a value. */
export function missingFields(template: DraftingTemplate, values: Record<string, string>): Array<{ fieldId: string; label: string; section: string; reason: "required" | "conditional" }> {
  const missing: Array<{ fieldId: string; label: string; section: string; reason: "required" | "conditional" }> = []
  for (const field of template.fields) {
    const reason = field.required === "always" ? "required" : conditionActive(template, field.required.when, values) ? "conditional" : null
    if (!reason) continue
    if (!(values[field.id] ?? "").trim()) missing.push({ fieldId: field.id, label: field.label, section: field.section, reason })
  }
  return missing
}

export function sectionTitle(template: DraftingTemplate, sectionId: string): string {
  return template.sections.find(section => section.id === sectionId)?.title ?? sectionId
}
