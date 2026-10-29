import { AuthService } from "../auth/service"
import { connectDatabase, type Database } from "../database/connection"
import { applyKnowledgeMigrations } from "./migrations"
import { PublicationService } from "./publication"
import { KnowledgeRepository } from "./repository"

/**
 * Synthetic C6 test fixtures.
 *
 * Every rule pack here is clearly labelled as a synthetic test fixture inside
 * its own manifest (`合成测试规则包…非法律规则`, description warns it is not
 * an acceptance/demo artefact). Fixtures only ever live in in-memory SQLite
 * databases created by tests; application startup never inserts them into a
 * real database. No real domain reviewer exists, so a fixture "publish" is a
 * mechanism test, not evidence of a published legal rule.
 */
export const operatorAccountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
export const operatorUsername = "ops-admin"
export const memberAccountId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
export const disabledOperatorId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
export const domainReviewer = "domain-reviewer"
export const secondReviewer = "domain-reviewer-2"
export const scene = "mep-sub-2026"
export const fixedNow = "2026-10-29T12:00:00.000Z"
export const fixedVerifiedAt = "2026-10-29T12:00:00.000Z"
export const artifactId = "synthetic-contract-review"

export const reviewerEnv: Record<string, string | undefined> = {
  EQUILENS_DOMAIN_REVIEWERS: `${domainReviewer},${secondReviewer}`,
}

export type SyntheticPackOptions = {
  scene?: string
  /** Pack manifest status. */
  status?: "草拟" | "待核对" | "已发布" | "已停用"
  ruleStatus?: "草拟" | "待核对" | "已发布" | "已停用"
  sourceStatus?: "草拟" | "待核对" | "已发布" | "已停用"
  extraRule?: boolean
}

type SyntheticRule = {
  ruleId: string
  category: string
  title: string
  status: string
  appliesTo: { scene: string; role: string }
  trigger: { keywords: string[] }
  requirement: string
  severity: string
  basis: Array<{ sourceId: string }>
  expectedSamples: string[]
}

type SyntheticSource = {
  sourceId: string
  type: string
  name: string
  text: string
  status: string
  reviewer?: string
  reviewedAt?: string
  illustrative?: boolean
}

export type SyntheticPack = { schemaVersion: number; manifest: Record<string, unknown>; rules: SyntheticRule[]; sources: SyntheticSource[] }

function source(status: string): SyntheticSource {
  return {
    sourceId: "SYN-SRC-1",
    type: "企业审查规则",
    name: "合成企业审查规则（C6 测试夹具，非真实法律依据）",
    text: "合成测试来源正文：本段仅用于验证发布机制，不构成任何法律结论或验收依据。",
    status,
    ...(status === "已发布" ? { reviewer: domainReviewer, reviewedAt: "2026-10-01T00:00:00.000Z" } : {}),
  }
}

function rule(status: string, sceneId: string): SyntheticRule {
  return {
    ruleId: "SYN-PAY-001",
    category: "付款条件与时间",
    title: "合成测试规则：付款条件",
    status,
    appliesTo: { scene: sceneId, role: "专业分包人" },
    trigger: { keywords: ["付款", "计量"] },
    requirement: "合成测试要求：验证付款条件是否明确（测试夹具文本，不是法律规则）。",
    severity: "重大关注",
    basis: [{ sourceId: "SYN-SRC-1" }],
    expectedSamples: [],
  }
}

/** Build one synthetic inline rule-pack document; default is draft (not publishable). */
export function syntheticPack(options: SyntheticPackOptions = {}): SyntheticPack {
  const status = options.status ?? "草拟"
  const sceneId = options.scene ?? scene
  const published = status === "已发布"
  const rules = [rule(options.ruleStatus ?? status, sceneId)]
  if (options.extraRule) {
    rules.push({
      ...rule(options.ruleStatus ?? status, sceneId),
      ruleId: "SYN-MEASURE-002",
      category: "计量结算",
      title: "合成测试规则：计量结算",
      trigger: { keywords: ["计量", "结算"] },
      requirement: "合成测试要求：验证计量结算条款（测试夹具文本，不是法律规则）。",
      severity: "一般关注",
    })
  }
  return {
    schemaVersion: 1,
    manifest: {
      version: "synthetic-2026.1",
      name: "合成测试规则包（C6 测试夹具，非法律规则）",
      status,
      description: "合成测试夹具：不得作为已发布法律规则、验收或演示证据；无真实领域核对。",
      ...(published ? { reviewer: domainReviewer, reviewedAt: "2026-10-01T00:00:00.000Z" } : {}),
    },
    rules,
    sources: [source(options.sourceStatus ?? status)],
  }
}

export function syntheticContent(options: SyntheticPackOptions = {}): string {
  return JSON.stringify(syntheticPack(options), null, 2)
}

/** Publishable content: pack, rules and sources are all 已发布. */
export function publishableContent(options: Omit<SyntheticPackOptions, "status" | "ruleStatus" | "sourceStatus"> = {}): string {
  return syntheticContent({ ...options, status: "已发布", ruleStatus: "已发布", sourceStatus: "已发布" })
}

export type KnowledgeFixture = {
  database: Database
  repository: KnowledgeRepository
  auth: AuthService
  service: PublicationService
  env: Record<string, string | undefined>
  now: Date
  close(): Promise<void>
}

function nextIdFactory(): () => string {
  let counter = 0
  return () => "00000000-0000-4000-8000-" + String(++counter).padStart(12, "0")
}

export async function setupKnowledge(options: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<KnowledgeFixture> {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await applyKnowledgeMigrations(database)
  await database.transaction(async connection => {
    await connection.query(
      "INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision,role) VALUES($1,$2,$3,$4,$5,$6)",
      [operatorAccountId, operatorUsername, "x", 1, 1, "superadmin"],
    )
    await connection.query(
      "INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision,role) VALUES($1,$2,$3,$4,$5,$6)",
      [memberAccountId, "team-member", "x", 1, 1, "member"],
    )
    await connection.query(
      "INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision,role) VALUES($1,$2,$3,$4,$5,$6)",
      [disabledOperatorId, "retired-admin", "x", 0, 1, "superadmin"],
    )
  })
  const now = options.now ?? new Date(fixedNow)
  const repository = new KnowledgeRepository(database, { now: () => now, id: nextIdFactory() })
  const auth = new AuthService(database)
  const env = options.env ?? reviewerEnv
  const service = new PublicationService({ repository, auth, env, now: () => now })
  return { database, repository, auth, service, env, now, async close() { await database.close() } }
}

export type SubmittedVersion = Awaited<ReturnType<PublicationService["submit"]>>

export async function submitDraft(fixture: KnowledgeFixture, options: { scene?: string; artifactId?: string; content?: string; reviewer?: string } = {}): Promise<SubmittedVersion> {
  return fixture.service.submit({
    kind: "rules",
    artifactId: options.artifactId ?? artifactId,
    scene: options.scene ?? scene,
    content: options.content ?? syntheticContent(),
    operatorId: operatorAccountId,
    ...(options.reviewer ? { reviewer: options.reviewer } : {}),
  })
}

export async function publishVersion(fixture: KnowledgeFixture, version: { versionId: string; sha256: string }, overrides: Partial<{
  reviewer: string; verifiedAt: string; expectedSha256: string; reviewEvidence: string; operatorId: string;
}> = {}) {
  return fixture.service.publish({
    versionId: version.versionId,
    operatorId: overrides.operatorId ?? operatorAccountId,
    reviewer: overrides.reviewer ?? domainReviewer,
    verifiedAt: overrides.verifiedAt ?? fixedVerifiedAt,
    expectedSha256: overrides.expectedSha256 ?? version.sha256,
    reviewEvidence: overrides.reviewEvidence ?? "合成测试核对证据：仅验证发布机制，非真实领域核对。",
  })
}

/** Submit + publish one synthetic rule pack and return the published version detail. */
export async function publishedFixturePack(fixture: KnowledgeFixture, options: { scene?: string; artifactId?: string } = {}) {
  const packScene = options.scene ?? scene
  const draft = await submitDraft(fixture, {
    scene: packScene,
    artifactId: options.artifactId,
    content: publishableContent({ scene: packScene }),
  })
  return publishVersion(fixture, draft)
}
