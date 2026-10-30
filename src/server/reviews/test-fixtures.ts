import { createHash } from "node:crypto"
import type { AuthIdentity } from "../auth/service"
import { connectDatabase, type Database } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { MaterialRepository } from "../materials/repository"
import type { CoverageFinding, ParseCoverage, SourceFragmentRecord } from "../materials/types"
import type { ProjectExecutionAccess, ProjectReviewConditions, ProjectReviewMaterialRef } from "../../lib/business/contracts"
import { ResultRepository } from "../results/repository"
import { productionResultValidators } from "../results/registry"
import { ResultService, type ResultAuthorizer } from "../results/service"
import { createSyntheticObjectStore, objectKey, type SyntheticObjectStore } from "../storage/obs"
import { TaskRepository, type ClaimedTask } from "../tasks/repository"
import type { TaskExecutor } from "../tasks/runner-core"
import type { ProjectReviewRunnerInput } from "./executor"
import type { ProjectReviewExecutorDependencies } from "./executor"
import { CHECK_CATEGORIES, type Finding, type ReviewResult } from "../../../tools/contract-review/src/types"

/**
 * Synthetic SQLite + private-store fixture for A4c tests. Uses the real
 * business migrations (0005 tasks, 0006 materials, 0007 results) so machine
 * result writes exercise the production tables, never ad-hoc DDL.
 */
export const projectId = "11111111-1111-4111-8111-111111111111"
export const accountId = "22222222-2222-4222-8222-222222222222"

export const testIdentity = { account: { id: accountId, username: "tester", role: "member" }, session: { id: "session", expiresAt: Date.now() + 3_600_000 } } as AuthIdentity
export const testAuthorizer: ResultAuthorizer = async (_identity, targetProjectId, action) => ({ projectId: targetProjectId, action, role: "editor", identity: testIdentity })

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const now = () => "2026-10-29T00:00:00.000Z"
const uuid = (prefix: string, value: number) => prefix + String(value).padStart(12, "0")

export type FixtureMaterial = {
  materialId: string
  versionId: string
  snapshotId: string
  sha256: string
  objectKey: string
  title: string
}

export type ReviewFixture = {
  database: Database
  repository: MaterialRepository
  store: SyntheticObjectStore
  results: ResultService
  tasks: TaskRepository
  projectRetention: string
  materials: FixtureMaterial[]
  addMaterial(texts: string[], options?: { title?: string; coverage?: ParseCoverage; retentionUntil?: string }): Promise<FixtureMaterial>
  claim(refs?: ProjectReviewMaterialRef[], conditions?: Partial<ProjectReviewConditions>): Promise<ClaimedTask>
  close(): Promise<void>
}

export async function setupReview(options: {
  fragments?: string[]
  coverage?: ParseCoverage
  materialRetention?: string
  projectRetention?: string
} = {}): Promise<ReviewFixture> {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(database)
  const projectRetention = options.projectRetention ?? "2099-12-31"
  await database.transaction(async connection => {
    await connection.query(
      "INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision,role) VALUES($1,$2,$3,$4,$5,$6)",
      [accountId, "tester", "x", 1, 1, "member"],
    )
    await connection.query(
      "INSERT INTO equilens_projects(id,name,source,source_reference,purpose,retention_until,status,created_by,created_at,updated_at,deleted_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11)",
      [projectId, "测试项目", "synthetic", "fixture", "工程验证", projectRetention, "active", accountId, now(), now(), 1],
    )
  })
  const store = createSyntheticObjectStore()
  const repository = new MaterialRepository(database)
  const results = new ResultService(new ResultRepository(database), productionResultValidators())
  const tasks = new TaskRepository(database)
  let materialCount = 0
  let taskCount = 0
  const fixture: ReviewFixture = {
    database, repository, store, results, tasks, projectRetention, materials: [],
    async addMaterial(texts, materialOptions = {}) {
      materialCount++
      const materialId = uuid("33333333-3333-4333-8333-", materialCount)
      const versionId = uuid("44444444-4444-4444-8444-", materialCount)
      const snapshotId = uuid("55555555-5555-4555-8555-", materialCount)
      const coverage: ParseCoverage = materialOptions.coverage ?? { status: "available", findings: [] as CoverageFinding[], pageCount: null, textLength: texts.join("\n").length }
      const bytes = new TextEncoder().encode(`synthetic-object-${materialCount}-${texts.join("|")}`)
      await store.put({ key: objectKey({ projectId, materialId, versionId, sha256: digest(bytes) }), bytes, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
      const fragments: SourceFragmentRecord[] = texts.map((text, index) => ({
        id: `fragment-${materialCount}-${index}`, projectId, snapshotId, kind: "paragraph", order: index,
        page: null, paragraph: index + 1, headingPath: [], tableIndex: null, row: null, column: null, text,
      }))
      await repository.create({
        material: {
          id: materialId, projectId, title: materialOptions.title ?? `材料 ${materialCount}`,
          fileName: `material-${materialCount}.docx`, format: "docx", sourceKind: "synthetic", sourceReference: "fixture",
          processingAuthorized: true, purpose: "工程验证", retentionUntil: materialOptions.retentionUntil ?? "2099-12-31",
          status: "active", latestRevision: 1, latestVersionId: versionId, createdBy: accountId, createdAt: now(),
        },
        version: {
          id: versionId, projectId, materialId, revision: 1, sha256: digest(bytes), size: bytes.byteLength,
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          objectKey: objectKey({ projectId, materialId, versionId, sha256: digest(bytes) }),
          fileName: `material-${materialCount}.docx`, createdAt: now(),
        },
        snapshot: { id: snapshotId, projectId, materialId, versionId, revision: 1, parser: "docx-ooxml", parserVersion: "c2-docx-1", coverage, createdAt: now() },
        fragments,
      })
      const material: FixtureMaterial = { materialId, versionId, snapshotId, sha256: digest(bytes), objectKey: objectKey({ projectId, materialId, versionId, sha256: digest(bytes) }), title: materialOptions.title ?? `材料 ${materialCount}` }
      fixture.materials.push(material)
      return material
    },
    async claim(refs, conditions = {}) {
      taskCount++
      const targets = refs ?? fixture.materials.map(material => ({ materialVersionId: material.versionId, sha256: material.sha256 }))
      const request = {
        kind: "contract-review", projectId, refs: { materials: targets },
        conditions: { scene: "auto", role: "专业分包人", region: "上海", externalProcessingConsent: true, unreviewedMaterialsConsent: true, ...conditions },
      }
      await tasks.submit(accountId, `review-test-${taskCount}`, request)
      const job = await tasks.claimNext()
      if (!job) throw new Error("review fixture could not claim the submitted task")
      return job
    },
    async close() { await database.close() },
  }
  await fixture.addMaterial(options.fragments ?? ["合同价款按月度计量支付。", "发包人逾期付款应承担违约责任。"], {
    title: "测试专业分包合同", coverage: options.coverage, retentionUntil: options.materialRetention,
  })
  return fixture
}

export function executorDependencies(fixture: ReviewFixture, overrides: Partial<ProjectReviewExecutorDependencies> = {}): ProjectReviewExecutorDependencies {
  return {
    repository: fixture.repository,
    store: fixture.store,
    readProjectRetention: async () => fixture.projectRetention,
    results: fixture.results,
    runner: async input => successResult(input),
    identityFor: account => ({ account: { id: account, username: "tester", role: "member" }, session: { id: "execution", expiresAt: 0 } }),
    authorize: async ({ projectId: target, action }) => ({ projectId: target, action, role: "editor", account: { id: accountId, username: "tester", role: "member" } } as ProjectExecutionAccess),
    now: () => new Date(now()),
    ...overrides,
  }
}

export function executorContext(overrides: Partial<Parameters<TaskExecutor>[1]> = {}): Parameters<TaskExecutor>[1] {
  return {
    signal: new AbortController().signal,
    heartbeat: async () => {},
    refreshAccess: async () => {},
    reserveCall: async () => {},
    settleCall: async () => {},
    ...overrides,
  }
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const paragraphList = (input: ProjectReviewRunnerInput) => input.paragraphs.map(paragraph => ({ index: paragraph.index, text: paragraph.text, inTable: false }))

/** A deterministic project-review runner input used by validator/template tests. */
export function validRunnerInput(): ProjectReviewRunnerInput {
  const paragraphs = [
    { index: 0, text: "合同价款按月度计量支付。", location: "测试专业分包合同 第 1 段" },
    { index: 1, text: "发包人逾期付款应承担违约责任。", location: "测试专业分包合同 第 2 段" },
  ]
  return {
    paragraphs, complete: true, documentTitle: "测试专业分包合同", documentVersionId: "version-1", parseSnapshotId: "snapshot-1",
    textSha256: sha(paragraphs.map(paragraph => paragraph.text).join("\n")),
    context: { scene: "mep-sub-2026", role: "专业分包人", region: "上海" },
    maxCalls: 25, signal: new AbortController().signal, env: {},
    onBeforeCall: async () => {},
    onExchange: async () => {},
  }
}

function baseResult(input: ProjectReviewRunnerInput): ReviewResult {
  const paragraphs = paragraphList(input)
  return {
    schemaVersion: 1, reviewId: "review-fixture", createdAt: now(), status: "success", mode: "debug",
    warnings: ["调试结果：使用未核对材料，仅用于开发联调，不形成正式法律结论。"], errors: [],
    input: {
      textSha256: sha(paragraphs.map(paragraph => paragraph.text).join("\n")),
      documentVersionId: input.documentVersionId, parseSnapshotId: input.parseSnapshotId,
      complete: input.complete, context: { scene: "mep-sub-2026", role: input.context.role, region: input.context.region },
    },
    callsUsed: 1, documentTitle: input.documentTitle, packVersion: "0.2.0-draft",
    paragraphs, findings: [], rejected: [], notLocated: [], coverage: [], usage: null, model: "fake-model",
  }
}

function finding(input: ProjectReviewRunnerInput, overrides: Partial<Finding> = {}): Finding {
  const paragraph = input.paragraphs[0]
  const quote = paragraph.text.slice(0, Math.min(20, paragraph.text.length))
  const result: Finding = {
    ruleId: "PAY-001", category: "付款条件与时间", kind: "发现问题", risk: "测试风险", severity: "重大关注",
    severityOrigin: "规则预设", quote, paragraphIndex: paragraph.index, basis: ["LEGAL-01"],
    impact: "测试影响", suggestion: "测试修改建议", pending: [], reviewStatus: "待人工复核",
    checkedParagraphIndexes: [paragraph.index],
    citations: [{ documentVersionId: input.documentVersionId, parseSnapshotId: input.parseSnapshotId, paragraphIndex: paragraph.index, quote }],
  }
  return { ...result, ...overrides }
}

function placeholderFinding(): Finding {
  return {
    ruleId: "PAY-002", category: "付款条件与时间", kind: "待核实", risk: "该必检项尚未取得有效结论", severity: "提示",
    severityOrigin: "规则预设", quote: "", paragraphIndex: -1, basis: [], impact: "", suggestion: "补充材料后重新审查",
    pending: ["该必检项尚未取得有效结论"], reviewStatus: "待人工复核", placeholder: true,
  }
}

function coverageReports(statuses: Record<string, "发现问题" | "未发现问题" | "缺失条款" | "待核实" | "未覆盖"> = {}) {
  return CHECK_CATEGORIES.map(category => ({
    category, status: statuses[category] ?? "未发现问题",
    findingIds: statuses[category] === "发现问题" ? ["PAY-001"] : [],
    note: "测试覆盖记录",
  }))
}

/** Complete machine result with one verbatim finding citation. */
export function successResult(input: ProjectReviewRunnerInput): ReviewResult {
  const result = baseResult(input)
  result.findings = [finding(input)]
  result.coverage = coverageReports({ "付款条件与时间": "发现问题" })
  result.summary = { issues: 1, pending: 0, rejected: 0, unreadParagraphs: 0 }
  return result
}

/** Partial machine result: one real finding plus an unresolved required item. */
export function partialResult(input: ProjectReviewRunnerInput): ReviewResult {
  const result = baseResult(input)
  result.status = "partial"
  result.findings = [finding(input), placeholderFinding()]
  result.coverage = coverageReports({ "付款条件与时间": "发现问题", "违约责任": "待核实" })
  result.summary = { issues: 1, pending: 1, rejected: 0, unreadParagraphs: 1 }
  return result
}

/** Invalid machine result: the finding quote cannot be located verbatim. */
export function invalidCitationResult(input: ProjectReviewRunnerInput): ReviewResult {
  const result = successResult(input)
  result.findings = [finding(input, { quote: "合同中不存在的引文", citations: [{ paragraphIndex: 0, quote: "合同中不存在的引文" }] })]
  return result
}

/** Failed machine result (no usable finding). */
export function failedResult(input: ProjectReviewRunnerInput): ReviewResult {
  const result = baseResult(input)
  result.status = "failed"
  result.findings = []
  result.coverage = coverageReports({})
  result.errors = [{ code: "AI_UPSTREAM_ERROR", message: "模型服务暂时不可用。", ruleIds: [] }]
  return result
}

/** A self-consistent ReviewResult usable as a human-authored saved value. */
export function humanReviewValue(): ReviewResult {
  const text = "人工保存的审查正文"
  const paragraph = { index: 0, text, inTable: false }
  return {
    schemaVersion: 1, reviewId: "review-human", createdAt: now(), status: "success", mode: "debug",
    warnings: ["调试结果：使用未核对材料，仅用于开发联调，不形成正式法律结论。"], errors: [],
    input: { textSha256: sha(text), documentVersionId: "human-version", parseSnapshotId: "human-snapshot", complete: true, context: { scene: "mep-sub-2026", role: "专业分包人", region: "上海" } },
    callsUsed: 0, documentTitle: "人工成果", packVersion: "0.2.0-draft", paragraphs: [paragraph], findings: [], rejected: [], notLocated: [],
    coverage: coverageReports({}), usage: null, model: "human",
  }
}
