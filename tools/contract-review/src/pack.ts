import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

import {
  CHECK_CATEGORIES,
  PUBLICATION_STATUSES,
  SEVERITIES,
  SOURCE_TYPES,
  type CheckCategory,
  type LoadedPack,
  type PublicationStatus,
  type RuleEntry,
  type RulePackManifest,
  type SourceEntry,
  type SourceType,
} from "./types"
import { isSceneId } from "./scenes"

const one = <T>(values: T[], value: unknown, field: string): T => {
  if (!values.includes(value as T)) throw new Error(`${field} 取值无效：${String(value)}`)
  return value as T
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串。`)
  return value
}

const optionalText = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined
  return text(value, field)
}

function parseSource(value: unknown, origin: string): SourceEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${origin} 的来源条目必须是对象。`)
  const entry = value as Record<string, unknown>
  const type = one<SourceType>(SOURCE_TYPES, entry.type, `${origin} 的来源类型`)
  const status = one<PublicationStatus>(PUBLICATION_STATUSES, entry.status, `${origin} 的来源发布状态`)
  const source: SourceEntry = {
    sourceId: text(entry.sourceId, `${origin} 的 sourceId`),
    type,
    name: text(entry.name, `${origin} 的名称`),
    article: optionalText(entry.article, `${origin} 的条文`),
    text: optionalText(entry.text, `${origin} 的原文`),
    issuer: optionalText(entry.issuer, `${origin} 的发布机关`),
    effectiveDate: optionalText(entry.effectiveDate, `${origin} 的施行日期`),
    version: optionalText(entry.version, `${origin} 的版本`),
    region: optionalText(entry.region, `${origin} 的地域`),
    officialUrl: optionalText(entry.officialUrl, `${origin} 的官方来源`),
    illustrative: entry.illustrative === true,
    status,
    reviewer: typeof entry.reviewer === "string" ? entry.reviewer : null,
    reviewedAt: typeof entry.reviewedAt === "string" ? entry.reviewedAt : null,
  }
  if (source.status === "已发布" && (!source.reviewer?.trim() || !source.reviewedAt?.trim() || !source.text?.trim() || source.illustrative)) {
    throw new Error(`${origin} 的已发布来源必须具有核对人、核对时间和正文，且不能是合成示例。`)
  }
  if (source.status === "已发布" && source.type === "法律依据" && !source.officialUrl?.startsWith("https://")) throw new Error(`${origin} 的已发布法律来源缺少官方 HTTPS 地址。`)
  return source
}

function parseRule(value: unknown, origin: string): RuleEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${origin} 的规则条目必须是对象。`)
  const entry = value as Record<string, unknown>
  const trigger = (entry.trigger ?? {}) as Record<string, unknown>
  const keywords = trigger.keywords
  if (!Array.isArray(keywords) || !keywords.length || keywords.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`${origin} 的规则必须提供非空触发关键词。`)
  }
  const basis = entry.basis
  if (!Array.isArray(basis) || !basis.length) throw new Error(`${origin} 的规则必须提供至少一个依据。`)
  const appliesTo = (entry.appliesTo ?? {}) as Record<string, unknown>
  const status = one<PublicationStatus>(PUBLICATION_STATUSES, entry.status, `${origin} 的规则发布状态`)
  const scene = optionalText(appliesTo.scene, `${origin} 的适用场景`)
  // 未知场景直接拒绝加载：拼错的场景标识不能静默变成"永不适用"。
  if (scene !== undefined && !isSceneId(scene)) throw new Error(`${origin} 的适用场景未登记：${scene}`)
  return {
    ruleId: text(entry.ruleId, `${origin} 的 ruleId`),
    category: one<CheckCategory>(CHECK_CATEGORIES, entry.category, `${origin} 的检查类别`),
    title: text(entry.title, `${origin} 的标题`),
    status,
    appliesTo: {
      scene,
      role: optionalText(appliesTo.role, `${origin} 的适用主体`),
      projectType: optionalText(appliesTo.projectType, `${origin} 的适用项目类型`),
      region: optionalText(appliesTo.region, `${origin} 的适用地域`),
    },
    mandatory: entry.mandatory !== false,
    trigger: {
      tags: Array.isArray(trigger.tags) ? trigger.tags.filter((item): item is string => typeof item === "string") : [],
      keywords: keywords as string[],
    },
    requirement: text(entry.requirement, `${origin} 的要求`),
    severity: one(SEVERITIES, entry.severity, `${origin} 的严重程度`),
    basis: basis.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`${origin} 的第 ${index + 1} 个依据无效。`)
      return { sourceId: text((item as Record<string, unknown>).sourceId, `${origin} 的依据 sourceId`) }
    }),
    expectedSamples: Array.isArray(entry.expectedSamples)
      ? entry.expectedSamples.filter((item): item is string => typeof item === "string")
      : [],
  }
}

async function readJson(path: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    throw new Error(`读取规则文件失败：${path}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`规则文件不是合法 JSON：${path}`)
  }
}

// 读取规则包。规则与来源都按发布状态过滤，只有"已发布"的条目进入审查。
export async function loadRulePack(directory: string): Promise<LoadedPack> {
  const manifestValue = await readJson(resolve(directory, "pack.json"))
  if (!manifestValue || typeof manifestValue !== "object" || Array.isArray(manifestValue)) throw new Error("pack.json 必须是对象。")
  const raw = manifestValue as Record<string, unknown>
  const fileList = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== "string" || !item.trim())) throw new Error(`${field} 必须是非空文件名列表。`)
    return value as string[]
  }
  const manifest: RulePackManifest = {
    version: text(raw.version, "规则包版本"),
    name: text(raw.name, "规则包名称"),
    status: one(PUBLICATION_STATUSES, raw.status, "规则包发布状态"),
    description: optionalText(raw.description, "规则包说明"),
    reviewer: typeof raw.reviewer === "string" ? raw.reviewer : null,
    reviewedAt: typeof raw.reviewedAt === "string" ? raw.reviewedAt : null,
    ruleFiles: fileList(raw.ruleFiles, "ruleFiles"),
    sourceFiles: fileList(raw.sourceFiles, "sourceFiles"),
  }
  const warnings: string[] = []
  if (manifest.status === "已发布" && (!manifest.reviewer?.trim() || !manifest.reviewedAt?.trim())) throw new Error("已发布规则包缺少核对人或核对时间。")
  const packFile = (file: string): string => {
    const path = resolve(directory, file)
    const inside = relative(resolve(directory), path)
    if (isAbsolute(file) || inside === ".." || inside.startsWith("..\\") || inside.startsWith("../") || isAbsolute(inside)) throw new Error("规则文件必须位于规则包目录内。")
    return path
  }
  const rules: RuleEntry[] = []
  for (const file of manifest.ruleFiles) {
    const value = await readJson(packFile(file))
    if (!Array.isArray(value)) throw new Error(`${file} 必须是规则数组。`)
    value.forEach((item, index) => rules.push(parseRule(item, `${file}[${index}]`)))
  }
  const sources: SourceEntry[] = []
  for (const file of manifest.sourceFiles) {
    const value = await readJson(packFile(file))
    if (!Array.isArray(value)) throw new Error(`${file} 必须是来源数组。`)
    value.forEach((item, index) => sources.push(parseSource(item, `${file}[${index}]`)))
  }
  const ruleIds = new Set<string>()
  for (const rule of rules) {
    if (ruleIds.has(rule.ruleId)) throw new Error(`规则编号重复：${rule.ruleId}`)
    ruleIds.add(rule.ruleId)
  }
  const sourceIds = new Set<string>()
  for (const source of sources) {
    if (sourceIds.has(source.sourceId)) throw new Error(`来源编号重复：${source.sourceId}`)
    sourceIds.add(source.sourceId)
  }
  const sourceById = new Map(sources.map(entry => [entry.sourceId, entry]))
  const unpublishedSources = new Set<string>()
  for (const rule of rules) {
    for (const item of rule.basis) {
      if (!sourceIds.has(item.sourceId)) throw new Error(`规则 ${rule.ruleId} 引用了不存在的来源 ${item.sourceId}。`)
      const source = sourceById.get(item.sourceId)!
      if (source.status !== "已发布") unpublishedSources.add(`${item.sourceId}（${source.status}）`)
    }
  }
  if (unpublishedSources.size) {
    warnings.push(`以下来源尚未发布，相关规则不能形成已核对结论：${[...unpublishedSources].join("、")}。`)
  }
  if (manifest.status !== "已发布") warnings.push(`规则包状态为${manifest.status}，仅用于验证流程，不构成已核对结论。`)
  return { manifest, rules, sources, warnings }
}

// 只有"已发布"的规则与来源可以进入正式结论；未发布条目在报告中单列。
export function publishedRules(pack: LoadedPack): RuleEntry[] {
  return pack.manifest.status === "已发布" ? pack.rules.filter((rule: RuleEntry) => rule.status === "已发布") : []
}

export function publishedSources(pack: LoadedPack): SourceEntry[] {
  return pack.manifest.status === "已发布" ? pack.sources.filter((source: SourceEntry) => source.status === "已发布") : []
}
