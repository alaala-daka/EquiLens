// 合同审查的共享类型。规则与来源均为不可变条目，任务只引用"已发布"版本。
import type { SceneCandidate } from "./scenes"
import type { AuditResult } from "./agent/audit"
import type { RoutingResult } from "./agent/router"
import type { RevisionState, RevisionAudit, RevisionRepair } from "./revision"
import type { DocumentAnalysis } from "../../../src/lib/document-agent/types"

export type Collaboration = {
  version: "multi-agent-v1" | "multi-agent-revision-v1" | "revision-only-v1"; manifestSha256: string
  phase: "identifying" | "reviewing" | "revising" | "auditing" | "completed"
  primaryCompleted: boolean; routing?: RoutingResult; primary?: ReviewResult; audit?: AuditResult
  revision?: RevisionState; revisionAudit?: RevisionAudit
  revisionRepair?: RevisionRepair
}

export type SceneSelection = {
  status: "matched" | "unsupported" | "needs-confirmation"
  sceneId: string | null
  reason: string
  evidence: { paragraphIndex: number; quote: string }[]
  missingInfo: string[]
}

export type PublicationStatus = "草拟" | "待核对" | "已发布" | "已停用"

export const PUBLICATION_STATUSES: PublicationStatus[] = ["草拟", "待核对", "已发布", "已停用"]

export type CheckCategory =
  | "付款条件与时间"
  | "计量结算"
  | "工期"
  | "变更签证"
  | "违约责任"
  | "争议约定"

export const CHECK_CATEGORIES: CheckCategory[] = [
  "付款条件与时间",
  "计量结算",
  "工期",
  "变更签证",
  "违约责任",
  "争议约定",
]

export type Severity = "重大关注" | "一般关注" | "提示"

export const SEVERITIES: Severity[] = ["重大关注", "一般关注", "提示"]

export type SourceType = "法律依据" | "企业审查规则" | "招标要求"

export const SOURCE_TYPES: SourceType[] = ["法律依据", "企业审查规则", "招标要求"]

// 来源条目：法律原文、企业规则或招标要求。模型引文只能指向其中"已发布"的条目。
export type SourceEntry = {
  sourceId: string
  type: SourceType
  name: string
  article?: string
  text?: string
  issuer?: string
  effectiveDate?: string
  version?: string
  region?: string
  officialUrl?: string
  illustrative?: boolean
  status: PublicationStatus
  reviewer?: string | null
  reviewedAt?: string | null
}

// 规则条目：一条可触发、可核对的审查要求。
export type RuleEntry = {
  ruleId: string
  category: CheckCategory
  title: string
  status: PublicationStatus
  /** scene 是判定依据；role/projectType/region 保留用于兼容旧规则包。 */
  appliesTo: { scene?: string; role?: string; projectType?: string; region?: string }
  /** 场景必检规则即使没有关键词命中也必须检查。默认 true。 */
  mandatory?: boolean
  trigger: { tags?: string[]; keywords: string[] }
  requirement: string
  severity: Severity
  basis: { sourceId: string }[]
  expectedSamples?: string[]
}

export type RulePackManifest = {
  version: string
  name: string
  status: PublicationStatus
  description?: string
  reviewer?: string | null
  reviewedAt?: string | null
  ruleFiles: string[]
  sourceFiles: string[]
}

export type LoadedPack = {
  manifest: RulePackManifest
  rules: RuleEntry[]
  sources: SourceEntry[]
  warnings: string[]
}

// 合同正文按段落切分，保留顺序以便定位原条款位置。
export type Paragraph = {
  index: number
  text: string
  inTable: boolean
  table?: { index: number; row: number; column: number }
}

export type MatchedExcerpt = {
  ruleId: string
  paragraphIndex: number
  text: string
}

export type TriggeredRule = {
  rule: RuleEntry
  excerpts: MatchedExcerpt[]
}

export type FindingKind = "发现问题" | "未发现问题" | "缺失条款" | "待核实"

export type Finding = {
  ruleId: string
  category: CheckCategory
  kind: FindingKind
  risk: string
  severity: Severity
  severityOrigin: "规则预设" | "模型提出待定级"
  quote: string
  paragraphIndex: number
  basis: string[]
  impact: string
  suggestion: string
  pending: string[]
  reviewStatus: "待人工复核"
  /** 后端为未取得有效结论的必检项补录的占位条目，不是模型结论，不参与复核。 */
  placeholder?: true
  checkedParagraphIndexes?: number[]
  citations?: {
    documentVersionId?: string
    parseSnapshotId?: string
    paragraphIndex: number
    quote: string
    table?: Paragraph["table"]
  }[]
  sourceReferences?: Pick<SourceEntry, "sourceId" | "type" | "name" | "article" | "version" | "officialUrl" | "status">[]
}

export type RejectedFinding = {
  ruleId: string
  reason: string
  detail: string
}

/**
 * 未能定位的规则。no-match：未纳入本次检查；outline-only：仅有目录、没有
 * 可引用的正文，不计为完整检查。
 */
export type NotLocated = {
  ruleId: string
  reason: "no-match" | "outline-only"
  detail: string
}

export type CategoryStatus = "发现问题" | "未发现问题" | "缺失条款" | "待核实" | "未覆盖"

export type CategoryReport = {
  category: CheckCategory
  status: CategoryStatus
  findingIds: string[]
  note: string
}

export type ReviewResult = {
  documentAnalysis?: DocumentAnalysis
  schemaVersion: 1
  reviewId: string
  createdAt: string
  status: "success" | "partial" | "failed"
  mode: "published" | "debug"
  warnings: string[]
  errors: { code: string; message: string; ruleIds: string[] }[]
  input: {
    textSha256: string
    documentVersionId?: string
    parseSnapshotId?: string
    complete: boolean
    context: ReviewContext
  }
  callsUsed: number
  documentTitle: string
  packVersion: string
  paragraphs: Paragraph[]
  findings: Finding[]
  rejected: RejectedFinding[]
  notLocated: NotLocated[]
  coverage: CategoryReport[]
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null
  model: string
  sceneCandidates?: SceneCandidate[]
  sceneSelection?: SceneSelection
  sceneSelectionReadParagraphIndexes?: number[]
  collaboration?: Collaboration
  agent?: {
    engine: "ai-sdk"
    skill: { id: string; version: string; sha256: string; loaded: boolean }
    readParagraphIndexes: number[]
    readSourceIds: string[]
    events: { tool: string; at: string; paragraphIndexes?: number[]; sourceIds?: string[]; ruleIds?: string[] }[]
    submissions: { ruleIds: string[]; readParagraphIndexes: number[]; readSourceIds: string[] }[]
    preparation?: { strategy: "prepared-v1"; manifestSha256: string; receipts: { promptSha256: string; ruleIds: string[]; paragraphIndexes: number[]; sourceIds: string[] }[] }
  }
  summary?: { issues: number; pending: number; rejected: number; unreadParagraphs: number }
}

export type ReviewContext = { scene?: string; role?: string; projectType?: string; region?: string }
