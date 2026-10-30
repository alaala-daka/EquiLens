import { createHash } from "node:crypto"
import { parseInlineRulePack, publishedRules, publishedSources } from "../../../tools/contract-review/src/pack"
import { isSceneId } from "../../../tools/contract-review/src/scenes"
import type { LoadedPack } from "../../../tools/contract-review/src/types"
import { canonicalJson } from "../results/validation"
import { KnowledgeError } from "./errors"
import {
  publicationContentSchemaVersion,
  supportedPublicationKinds,
  type PreparedPublicationContent,
  type PublicationKind,
  type PublicationVersionRecord,
} from "./types"

/**
 * Content validation for published rule packs (C6).
 *
 * A stored version keeps three columns whose canonical JSON together form the
 * version digest: `payload_json` ({schemaVersion, manifest, rules}),
 * `sources_json` and `applicability_json`. The private CLI submits one JSON
 * file; the same loader re-validates the stored content whenever a pinned task
 * executes, so a tampered row can never be silently reviewed.
 *
 * File references are rejected on submit: a published pack is inline content —
 * it must not name local files, paths or directories, and no path is stored.
 * `publishBlockers` implements the "only published sources/basis may form a
 * published pack" rule (spec/01 §7.1).
 */
const publicationMaxChars = 2_000_000
const allowedTopLevelKeys = new Set(["schemaVersion", "manifest", "rules", "sources"])
const forbiddenKeys = new Set([
  "ruleFiles", "sourceFiles", "file", "files", "path", "paths", "filePath", "filepath",
  "localPath", "dir", "directory", "objectKey", "objectKeys",
])

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

function pathLike(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value) ||
    /^(?:\.{1,2}[\\/]|file:)/i.test(value) ||
    /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(value) ||
    /(?:^|[^A-Za-z0-9])\\\\[A-Za-z0-9]/.test(value) ||
    value.includes("../") || value.includes("..\\")
}

function assertNoFileReferences(value: unknown, path = "内容", depth = 0): void {
  if (depth > 24) throw new KnowledgeError("INVALID_CONTENT", "内容嵌套过深。")
  if (typeof value === "string") {
    if (pathLike(value)) throw new KnowledgeError("INVALID_CONTENT", `内容包含文件路径引用（${path}）。`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoFileReferences(item, `${path}[${index}]`, depth + 1))
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenKeys.has(key)) throw new KnowledgeError("INVALID_CONTENT", `内容包含文件引用字段（${key}）。`)
    assertNoFileReferences(item, `${path}.${key}`, depth + 1)
  }
}

/** Stable artifact ids only; path-shaped identifiers are rejected before any SQL. */
export function assertPublicationArtifactId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || value.includes("..")) {
    throw new KnowledgeError("INVALID_INPUT", "制品标识无效。")
  }
  return value
}

export function assertPublicationScene(value: string): string {
  if (!isSceneId(value)) throw new KnowledgeError("INVALID_INPUT", "适用场景未登记。")
  return value
}

export function publicationDigest(payload: unknown, sources: unknown[], applicability: Record<string, unknown>): string {
  return digest(canonicalJson({ payload, sources, applicability }))
}

function blockersFor(pack: LoadedPack): string[] {
  const blockers: string[] = []
  if (pack.manifest.status !== "已发布") blockers.push(`规则包状态为${pack.manifest.status}，尚未发布`)
  if (!pack.manifest.reviewer?.trim()) blockers.push("规则包缺少核对人")
  if (!pack.manifest.reviewedAt?.trim()) blockers.push("规则包缺少核对时间")
  for (const rule of pack.rules) if (rule.status !== "已发布") blockers.push(`规则 ${rule.ruleId} 尚未发布`)
  for (const source of pack.sources) if (source.status !== "已发布") blockers.push(`来源 ${source.sourceId} 尚未发布`)
  if (!publishedRules(pack).length) blockers.push("没有可进入正式结论的已发布规则")
  if (!publishedSources(pack).length) blockers.push("没有可进入正式结论的已发布来源")
  return blockers
}

/** Strip optional `undefined` members so canonical JSON (which rejects them) is stable. */
const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function storageManifest(pack: LoadedPack) {
  return {
    version: pack.manifest.version,
    name: pack.manifest.name,
    status: pack.manifest.status,
    ...(pack.manifest.description !== undefined ? { description: pack.manifest.description } : {}),
    ...(pack.manifest.reviewer ? { reviewer: pack.manifest.reviewer } : {}),
    ...(pack.manifest.reviewedAt ? { reviewedAt: pack.manifest.reviewedAt } : {}),
  }
}

/**
 * Parse and validate one submitted rule-pack JSON document.
 * Draft-grade structure is required here; `publishBlockers` distinguishes what
 * still blocks the `published` transition (review guard runs in publication.ts).
 */
export function prepareRulePackContent(kind: PublicationKind, scene: string, raw: string): PreparedPublicationContent {
  if (!supportedPublicationKinds.includes(kind)) {
    throw new KnowledgeError("INVALID_CONTENT", "本轮只定义了规则包（rules）的发布内容契约。")
  }
  if (typeof raw !== "string" || !raw.trim() || raw.length > publicationMaxChars) {
    throw new KnowledgeError("INVALID_CONTENT", "发布内容为空或超过大小上限。")
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new KnowledgeError("INVALID_CONTENT", "发布内容不是合法 JSON。") }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new KnowledgeError("INVALID_CONTENT", "发布内容必须是对象。")
  const record = parsed as Record<string, unknown>
  assertNoFileReferences(record)
  for (const key of Object.keys(record)) {
    if (!allowedTopLevelKeys.has(key)) throw new KnowledgeError("INVALID_CONTENT", `发布内容包含未允许的顶层字段（${key}）。`)
  }
  if (record.schemaVersion !== publicationContentSchemaVersion) {
    throw new KnowledgeError("INVALID_CONTENT", "发布内容版本不受支持。")
  }
  if (!isSceneId(scene)) throw new KnowledgeError("INVALID_INPUT", "适用场景未登记。")
  let pack: LoadedPack
  try {
    pack = parseInlineRulePack({ manifest: record.manifest, rules: record.rules, sources: record.sources })
  } catch (failure) {
    const message = failure instanceof Error ? failure.message.slice(0, 300) : "规则包结构无效。"
    throw new KnowledgeError("INVALID_CONTENT", message)
  }
  for (const rule of pack.rules) {
    if (rule.appliesTo.scene !== scene) {
      throw new KnowledgeError("INVALID_CONTENT", `规则 ${rule.ruleId} 的适用场景与发布场景不一致。`)
    }
    if (rule.appliesTo.role !== "专业分包人") {
      throw new KnowledgeError("INVALID_CONTENT", `规则 ${rule.ruleId} 的适用主体与发布场景不一致。`)
    }
  }
  const payload = jsonClone({ schemaVersion: publicationContentSchemaVersion, manifest: storageManifest(pack), rules: pack.rules })
  const sources = jsonClone(pack.sources)
  const applicability = { scene, role: "专业分包人" }
  const payloadJson = canonicalJson(payload)
  const sourcesJson = canonicalJson(sources)
  const applicabilityJson = canonicalJson(applicability)
  return {
    payload,
    sources,
    applicability,
    payloadJson,
    sourcesJson,
    applicabilityJson,
    sha256: publicationDigest(payload, sources, applicability),
    pack,
    warnings: [...pack.warnings],
    publishBlockers: blockersFor(pack),
    manifestName: pack.manifest.name,
    manifestVersion: pack.manifest.version,
    manifestStatus: pack.manifest.status,
  }
}

/**
 * Rebuild the loadable pack structure from stored columns. Draft content is
 * accepted here (structure + scene/applicability consistency); the published
 * requirements are enforced by `rulePackFromStored`.
 */
export function rulePackStructureFromStored(version: PublicationVersionRecord): LoadedPack {
  const payload = version.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new KnowledgeError("INVALID_CONTENT", "存储的规则包载荷无效。")
  }
  const record = payload as Record<string, unknown>
  if (record.schemaVersion !== publicationContentSchemaVersion || !record.manifest || !record.rules) {
    throw new KnowledgeError("INVALID_CONTENT", "存储的规则包载荷版本或结构无效。")
  }
  let pack: LoadedPack
  try {
    pack = parseInlineRulePack({ manifest: record.manifest, rules: record.rules, sources: version.sources })
  } catch {
    throw new KnowledgeError("INVALID_CONTENT", "存储的规则包未通过校验。")
  }
  const scene = typeof version.applicability.scene === "string" ? version.applicability.scene : ""
  if (scene !== version.scene) throw new KnowledgeError("INVALID_CONTENT", "存储的规则包适用场景不一致。")
  for (const rule of pack.rules) {
    if (rule.appliesTo.scene !== version.scene || rule.appliesTo.role !== "专业分包人") {
      throw new KnowledgeError("INVALID_CONTENT", "存储的规则包适用条件不一致。")
    }
  }
  return pack
}

/**
 * Rebuild the loadable pack from stored columns and re-validate it as a
 * published pack. Used both by the pinned-pack loader and by the publish
 * transition (so a tampered payload cannot be published or executed).
 */
export function rulePackFromStored(version: PublicationVersionRecord): LoadedPack {
  const pack = rulePackStructureFromStored(version)
  const blockers = blockersFor(pack)
  if (blockers.length) throw new KnowledgeError("INVALID_CONTENT", "存储的规则包尚未达到发布要求。")
  return pack
}

/** Rule/source counts for redacted maintenance output; never returns content text. */
export function storedContentSummary(version: PublicationVersionRecord): { ruleCount: number; sourceCount: number; manifestName: string | null; manifestVersion: string | null; manifestStatus: string | null; warnings: string[] } {
  let pack: LoadedPack
  try { pack = rulePackStructureFromStored(version) } catch { return { ruleCount: 0, sourceCount: 0, manifestName: null, manifestVersion: null, manifestStatus: null, warnings: ["存储内容未通过校验"] } }
  return {
    ruleCount: pack.rules.length,
    sourceCount: pack.sources.length,
    manifestName: pack.manifest.name,
    manifestVersion: pack.manifest.version,
    manifestStatus: pack.manifest.status,
    warnings: pack.warnings,
  }
}
