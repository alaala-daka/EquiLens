/**
 * Round-six A5 reproducible project seed + offline verification helpers.
 *
 * Creates a fresh synthetic root with a complete project so backup/restore drills
 * can be reproduced: accounts/members, project + budget, parsed DOCX materials,
 * C4 manual certificate fields + confirmed requirement set + a *real* deterministic
 * bid-verification task result (executor run in-process against the seeded data)
 * that is validated and approved, C5 proposed-input + partial draft result,
 * a versioned Word export, and finished task history. A second project is seeded
 * for the two-way deletion/replay drill.
 *
 * Subcommands:
 *   seed                 create a new synthetic root (database + dev-file objects +
 *                        deletion journal dir + checkpoint JSON). Refuses existing roots.
 *   migrations           run the business migration ledger checks (empty DB, repeat,
 *                        frozen 0001—0012 checksums, 0013 when registered, drift and
 *                        rollback rejection) and optionally emit a ledger reference.
 *   capacity-repository  deterministic repository-level capacity boundaries
 *                        (per-user 2 unfinished, global queue 10, idempotency, 429)
 *                        with a controlled clock; prints measurements (no SLA).
 *   capacity-http        CLI helper for the HTTP 5-synthetic-user capacity leg: creates
 *                        5 accounts/memberships in the target DB, then requires a
 *                        running local server to measure parallel request latency/errors.
 *
 * Local synthetic evidence only: no real OBS/GaussDB/CI/HTTPS claim. Nothing here
 * starts a server or runs migrations on import.
 *
 * Usage:
 *   pnpm exec tsx scripts/seed-restore-project.mts seed --root "%TEMP%\equilens-r6-a5\seed"
 *   pnpm exec tsx scripts/seed-restore-project.mts migrations
 *   pnpm exec tsx scripts/seed-restore-project.mts capacity-repository
 */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ProjectAccess as ProjectAccessView, ProjectAction, ProjectRole } from "../src/lib/business/contracts"
import { docxFromParagraphs } from "../src/lib/documents/docx"
import type { AuthIdentity } from "../src/server/auth/service"
import { AuthService } from "../src/server/auth/service"
import { connectDatabase } from "../src/server/database/connection"
import { businessMigrations, migrateBusiness } from "../src/server/database/migrations"
import type { DraftingInputView } from "../src/server/drafting/service"
import { DraftingService } from "../src/server/drafting/service"
import { ExportRepository } from "../src/server/exports/repository"
import { ExportService } from "../src/server/exports/service"
import { productionExportTemplates } from "../src/server/exports/template"
import { MaterialRepository } from "../src/server/materials/repository"
import { MaterialService } from "../src/server/materials/service"
import { ProjectRepository } from "../src/server/projects/repository"
import { ResultRepository } from "../src/server/results/repository"
import { productionResultValidators } from "../src/server/results/registry"
import type { ResultService } from "../src/server/results/service"
import { ResultService as ResultServiceImpl } from "../src/server/results/service"
import { createFileObjectStore } from "../src/server/storage/file-store"
import { DraftingInputRepository } from "../src/server/templates/repository"
import { TaskBudgetRepository } from "../src/server/tasks/budget"
import { TaskRepository } from "../src/server/tasks/repository"
import { taskLimits } from "../src/server/tasks/limits"
import type { TaskExecutor } from "../src/server/tasks/runner-core"
import { createBidVerificationExecutor } from "../src/server/verification/executor"
import { OcrRepository, VerificationFieldService } from "../src/server/verification/ocr-repository"
import { VerificationRecordRepository } from "../src/server/verification/records-repository"
import { VerificationService } from "../src/server/verification/service"

const now = () => new Date()
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

type Options = Record<string, string | boolean>

function parseArgs(argv: string[]): { command: string; options: Options } {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "seed"
  const options: Options = {}
  for (let index = command === argv[0] ? 1 : 0; index < argv.length; index++) {
    const key = argv[index]
    if (!key.startsWith("--")) throw new Error(`未知参数：${key}`)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) { options[key.slice(2)] = true; continue }
    options[key.slice(2)] = next
    index++
  }
  return { command, options }
}

function option(options: Options, name: string): string | undefined {
  const value = options[name]
  return typeof value === "string" ? value : undefined
}

function requiredOption(options: Options, name: string): string {
  const value = option(options, name)
  if (!value) throw new Error(`缺少参数 --${name}`)
  return value
}

/** Asia/Shanghai calendar day, offset in days. */
function shanghaiDay(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + offsetDays * 86_400_000))
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" })
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

const projectName = "第六轮 A5 恢复演练合成项目"
const deletionProjectName = "第六轮 A5 删除演练合成项目"
const seedPassword = "a5-restore-pass-123" // synthetic local fixture; never a production secret

type Role = "admin" | "editor" | "viewer"

async function createAccount(auth: AuthService, username: string, password: string): Promise<AuthIdentity> {
  await auth.maintain({ action: "create", username, password, actor: "a5-seed" })
  const account = await auth.account((await auth.login(username, password, "deployment")).user.id)
  if (!account) throw new Error(`账号创建后不可读：${username}`)
  return { account, session: { id: `seed-session-${account.id}`, expiresAt: Date.now() + 12 * 3600000 } }
}

async function seed(options: Options): Promise<void> {
  const root = resolve(requiredOption(options, "root"))
  if (existsSync(root)) throw new Error(`合成根目录已存在，拒绝覆盖：${root}`)
  const databasePath = join(root, "equilens.sqlite")
  const objectsRoot = join(root, "objects")
  const journalDir = join(root, "deletion-journal")
  const checkpointPath = join(root, "checkpoint.json")
  mkdirSync(root, { recursive: true })
  mkdirSync(objectsRoot, { recursive: true })
  mkdirSync(journalDir, { recursive: true })

  const password = option(options, "password") ?? process.env.A5_SEED_PASSWORD ?? seedPassword
  const startedAt = Date.now()
  const database = await connectDatabase({ provider: "sqlite", path: databasePath })
  try {
    await migrateBusiness(database)
    const auth = new AuthService(database)
    const owner = await createAccount(auth, "a5owner", password)
    const editor = await createAccount(auth, "a5editor", password)
    const viewer = await createAccount(auth, "a5viewer", password)

    const projectRepository = new ProjectRepository(database)
    const projectRetention = shanghaiDay(365)
    const materialRetention = shanghaiDay(30)
    const project = await projectRepository.create({
      name: projectName, source: "synthetic", sourceReference: "第六轮 A5 恢复演练合成样本",
      purpose: "第六轮 A5 备份/恢复/删除重放演练", retentionUntil: projectRetention,
    }, owner.account.id)
    for (const [identity, role] of [[editor, "editor"], [viewer, "viewer"]] as Array<[AuthIdentity, Role]>) {
      const account = await projectRepository.findAccount(identity.account.username)
      if (!account) throw new Error("成员账号缺失")
      await projectRepository.addMember(project.id, account, role as ProjectRole, owner.account.id)
    }

    const budget = new TaskBudgetRepository(database)
    const budgetCostFen = 5000
    await budget.registerProjectBudget(project.id, budgetCostFen, owner.account.id)

    const store = createFileObjectStore(objectsRoot)
    const materialRepository = new MaterialRepository(database)
    const readProjectRetention = async (projectId: string) => (await projectRepository.findActive(projectId))?.retentionUntil ?? null
    // Synthetic fixture authorizer: the seed writes real rows through the real
    // services but does not need a browser session; role snapshots are explicit.
    const authorize = async (identity: AuthIdentity, projectId: string, action: ProjectAction): Promise<ProjectAccessView> => ({
      projectId, action, role: identity.account.id === viewer.account.id ? "viewer" : "admin", identity,
    })
    const materialService = new MaterialService({
      repository: materialRepository, store, requireProjectAccess: authorize,
      readProject: async projectId => { const record = await projectRepository.findActive(projectId); return record ? { retentionUntil: record.retentionUntil } : null },
    })

    async function registerMaterial(title: string, paragraphs: string[], projectId = project.id): Promise<{ materialId: string; versionId: string; snapshotId: string; sha256: string; objectKey: string }> {
      const bytes = new Uint8Array(await (await docxFromParagraphs(paragraphs)).arrayBuffer())
      const result = await materialService.registerMaterial(owner, {
        projectId, title, fileName: `${title}.docx`, sourceKind: "synthetic", sourceReference: "第六轮 A5 恢复演练合成样本",
        processingAuthorized: true, purpose: "A5 备份恢复演练合成材料", retentionUntil: materialRetention,
      }, bytes)
      return { materialId: result.material.id, versionId: result.version.id, snapshotId: result.snapshot.id, sha256: result.version.sha256, objectKey: result.version.objectKey }
    }

    const tender = await registerMaterial("招标文件-资格要求", [
      "第一章 投标人资格要求",
      "投标人企业名称为示例建设集团有限公司。",
      "投标人统一社会信用代码为91310000MA1FL0XXXX。",
    ])
    const certificate = await registerMaterial("企业营业执照信息表", [
      "企业营业执照（副本）",
      "企业名称：示例建设集团有限公司",
      "统一社会信用代码：91310000MA1FL0XXXX",
    ])
    const tenderFragments = await materialRepository.fragments(tender.snapshotId)
    const certificateFragments = await materialRepository.fragments(certificate.snapshotId)
    const findFragment = (rows: Array<{ id: string; text: string }>, needle: string) => {
      const found = rows.find(row => row.text.includes(needle))
      if (!found) throw new Error(`合成片段缺少内容：${needle}`)
      return found
    }
    const subjectQuote = findFragment(tenderFragments, "示例建设集团有限公司")
    const codeQuote = findFragment(tenderFragments, "91310000MA1FL0XXXX")
    const subjectSource = findFragment(certificateFragments, "示例建设集团有限公司")
    const codeSource = findFragment(certificateFragments, "91310000MA1FL0XXXX")

    const ocrRepository = new OcrRepository(database)
    const fieldService = new VerificationFieldService({
      repository: ocrRepository, materials: materialRepository, requireProjectAccess: authorize,
      readProjectRetention, now,
    })
    const fieldOperation = `a5-fields-${Date.now()}`
    const fields = await fieldService.register(owner, { projectId: project.id, materialId: certificate.materialId, versionId: certificate.versionId }, {
      operationId: fieldOperation, reason: "A5 恢复演练人工登记",
      fields: [
        { fieldKey: "subject_name", valueText: "示例建设集团有限公司", subjectKey: "enterprise", sourceFragmentId: subjectSource.id },
        { fieldKey: "unified_social_credit_code", valueText: "91310000MA1FL0XXXX", subjectKey: "enterprise", sourceFragmentId: codeSource.id },
      ],
    })
    assert.equal(fields.fields.length, 2)
    assert.ok(fields.fields.every(field => field.support === "material_text"))

    const results: ResultService = new ResultServiceImpl(
      new ResultRepository(database), productionResultValidators(),
      new Set(["contract-review", "bid-requirements", "bid-verification"]),
      new Set(["bid-requirements"]),
    )
    const records = new VerificationRecordRepository(database)
    const verificationService = new VerificationService({
      materials: materialRepository, results, records, fieldSource: ocrRepository, readProjectRetention, now,
    })
    const requirements = {
      schemaVersion: 1, status: "confirmed", rejected: [], warnings: [], errors: [],
      requirements: [
        {
          requirementId: "req-subject", subject: "投标人", quote: subjectQuote.text, materialVersionId: tender.versionId,
          source: { snapshotId: tender.snapshotId, fragmentId: subjectQuote.id }, addendum: { state: "none", note: "" },
          nature: "资格否决", field: "subject_name", operator: "eq", value: "示例建设集团有限公司", asOfRule: "not_applicable",
          materialRelation: "企业营业执照", group: null, status: "confirmed", statusNote: "",
        },
        {
          requirementId: "req-code", subject: "投标人", quote: codeQuote.text, materialVersionId: tender.versionId,
          source: { snapshotId: tender.snapshotId, fragmentId: codeQuote.id }, addendum: { state: "none", note: "" },
          nature: "资格否决", field: "unified_social_credit_code", operator: "eq", value: "91310000MA1FL0XXXX", asOfRule: "not_applicable",
          materialRelation: "企业营业执照", group: null, status: "confirmed", statusNote: "",
        },
      ],
    }
    const requirementSet = await verificationService.saveRequirementSet(owner, authorize, {
      projectId: project.id, baseVersionId: "", operationId: `a5-requirements-${Date.now()}`,
      reason: "A5 恢复演练要求集", value: requirements,
    })
    assert.equal(requirementSet.validation.status, "valid")

    // Real deterministic comparison through the production executor (no model call).
    const tasks = new TaskRepository(database, { budget })
    const submitted = await tasks.submit(owner.account.id, `a5-compare-${Date.now()}`, {
      kind: "bid-verification", projectId: project.id,
      refs: {
        materials: [{ materialVersionId: certificate.versionId, sha256: certificate.sha256 }],
        requirementSet: { id: requirementSet.resultId, versionId: requirementSet.versionId, sha256: requirementSet.sha256 },
        externalRecords: [],
      },
      conditions: { asOf: shanghaiDay(0) },
    })
    const claimed = await tasks.claimNext()
    if (!claimed || claimed.id !== submitted.task.id) throw new Error("核验任务领取失败")
    const ownerAccount = owner.account
    const executor = createBidVerificationExecutor({
      repository: materialRepository, records, fieldSource: ocrRepository, results,
      readProjectRetention, identityFor: () => owner,
      authorize: async input => ({ projectId: input.projectId, action: input.action, role: "admin", account: ownerAccount }),
      now,
    })
    const context: Parameters<TaskExecutor>[1] = {
      signal: new AbortController().signal, heartbeat: async () => {}, refreshAccess: async () => {},
      reserveCall: async () => {}, settleCall: async () => {},
    }
    const execution = await executor(claimed, context)
    await tasks.finish(claimed, { state: execution.outcome, resultSummary: execution.resultSummary, errorCode: execution.errorCode, errorMessage: execution.errorMessage })
    if (execution.outcome !== "success") throw new Error(`核验任务失败：${execution.errorCode ?? execution.outcome} ${execution.errorMessage ?? ""}`)
    const resultList = await results.list(owner, authorize, project.id)
    const comparison = resultList.find(view => view.kind === "bid-verification")
    if (!comparison) throw new Error("核验成果缺失")
    assert.equal(comparison.validation.status, "valid", `核验成果校验未通过：${JSON.stringify(comparison.validation.issues)}`)
    const reviewed = await results.reviewResult(owner, authorize, {
      projectId: project.id, resultId: comparison.resultId, versionId: comparison.versionId,
      sha256: comparison.sha256, decision: "approved", comment: "A5 恢复演练复核通过（合成本地）",
    })
    assert.equal(reviewed.review?.decision, "approved")

    // C5 proposed input + partial draft + versioned Word export (server-owned path).
    const draftingRepository = new DraftingInputRepository(database)
    const draftingService = new DraftingService({ repository: draftingRepository, materials: materialRepository, results, readProjectRetention, now })
    const savedInput: DraftingInputView = await draftingService.saveInput(owner, authorize, {
      projectId: project.id, templateId: "specialty-subcontract-v1", baseVersionId: "",
      operationId: `a5-drafting-input-${Date.now()}`,
      fields: { "project.name": projectName, "project.location": "上海市" },
    })
    const draft = await draftingService.generateDraft(owner, authorize, {
      projectId: project.id,
      inputId: savedInput.input.inputId, versionId: savedInput.input.versionId, sha256: savedInput.input.sha256,
      operationId: `a5-draft-${Date.now()}`, reason: "A5 恢复演练生成待核对草稿",
    })
    assert.equal(draft.kind, "specialty-subcontract")
    assert.equal(draft.validation.status, "partial")

    const exportRetention = async (ref: { projectId: string; resultId: string; versionId?: string; sha256?: string }) => database.transaction(async connection => {
      const projectRow = (await connection.query("SELECT retention_until FROM equilens_projects WHERE id=$1 AND status='active'", [ref.projectId])).rows[0]
      const version = (await connection.query("SELECT sources_json FROM equilens_result_versions WHERE project_id=$1 AND result_id=$2 AND id=$3 AND sha256=$4", [ref.projectId, ref.resultId, ref.versionId!, ref.sha256!])).rows[0]
      if (!projectRow || !version) return null
      const deadlines = [Date.parse(String(projectRow.retention_until))]
      for (const source of JSON.parse(String(version.sources_json)) as Array<{ snapshotId: string }>) {
        const material = (await connection.query("SELECT m.retention_until FROM equilens_materials m JOIN equilens_parse_snapshots s ON s.material_id=m.id AND s.project_id=m.project_id WHERE s.project_id=$1 AND s.id=$2 AND m.status='active'", [ref.projectId, source.snapshotId])).rows[0]
        if (!material) return null
        deadlines.push(Date.parse(String(material.retention_until)))
      }
      const dependencies = (await connection.query("SELECT dependency_version_id FROM equilens_result_dependencies WHERE project_id=$1 AND result_id=$2 AND version_id=$3 AND dependency_kind='material'", [ref.projectId, ref.resultId, ref.versionId!])).rows
      for (const dependency of dependencies) {
        const material = (await connection.query("SELECT m.retention_until FROM equilens_materials m JOIN equilens_material_versions v ON v.material_id=m.id AND v.project_id=m.project_id WHERE m.project_id=$1 AND v.id=$2 AND m.status='active'", [ref.projectId, String(dependency.dependency_version_id)])).rows[0]
        if (!material) return null
        deadlines.push(Date.parse(String(material.retention_until)))
      }
      return deadlines.every(Number.isFinite) ? new Date(Math.min(...deadlines)).toISOString() : null
    })
    const exportService = new ExportService(new ExportRepository(database), results, store, productionExportTemplates(), exportRetention)
    const exportRef = await exportService.createExport(owner, authorize, {
      projectId: project.id, resultId: draft.resultId, versionId: draft.versionId!, sha256: draft.sha256,
    })
    const exportRow = (await database.transaction(c => c.query("SELECT object_key,sha256 FROM equilens_result_exports WHERE project_id=$1 AND id=$2", [project.id, exportRef.exportId]))).rows[0]
    if (!exportRow) throw new Error("导出记录缺失")
    const exportObjectKeyValue = String(exportRow.object_key)
    const exportFileSha = String(exportRow.sha256)
    const exportObject = await store.get(exportObjectKeyValue)
    assert.ok(exportObject, "导出对象缺失")
    assert.equal(sha256(exportObject.bytes), exportFileSha)

    // Second project for the two-way deletion/replay drill.
    const deletionProject = await projectRepository.create({
      name: deletionProjectName, source: "synthetic", sourceReference: "第六轮 A5 删除演练合成样本",
      purpose: "A5 删除重放演练", retentionUntil: projectRetention,
    }, owner.account.id)
    const deletionMaterial = await registerMaterial("删除演练材料", ["删除演练正文：本材料应随项目删除而清除。"], deletionProject.id)

    const objectKeys = await (async () => {
      const keys: string[] = []
      for (const projectId of [project.id, deletionProject.id]) {
        const versions = await database.transaction(c => c.query("SELECT object_key FROM equilens_material_versions WHERE project_id=$1", [projectId]))
        keys.push(...versions.rows.map(row => String(row.object_key)))
        const exports = await database.transaction(c => c.query("SELECT object_key FROM equilens_result_exports WHERE project_id=$1", [projectId]))
        keys.push(...exports.rows.map(row => String(row.object_key)))
      }
      return [...new Set(keys)].sort()
    })()
    const checkpoint = {
      version: 1,
      seedVersion: "a5-r6-v1",
      createdAt: new Date().toISOString(),
      root, databasePath, objectsRoot, journalDir,
      project: { id: project.id, name: project.name, retentionUntil: project.retentionUntil },
      accounts: [
        { username: "a5owner", role: "admin", accountId: owner.account.id },
        { username: "a5editor", role: "editor", accountId: editor.account.id },
        { username: "a5viewer", role: "viewer", accountId: viewer.account.id },
      ],
      budget: { costLimitFen: budgetCostFen },
      materials: [
        { title: "招标文件-资格要求", ...tender, fragments: { subjectQuote: subjectQuote.text, codeQuote: codeQuote.text } },
        { title: "企业营业执照信息表", ...certificate, fragments: { subjectSource: subjectSource.text, codeSource: codeSource.text } },
      ],
      fields: fields.fields.map(field => ({ fieldKey: field.fieldKey, valueText: field.valueText, normalizedValue: field.normalizedValue, support: field.support, sourceFragmentId: field.sourceFragmentId })),
      requirementSet: { resultId: requirementSet.resultId, versionId: requirementSet.versionId, sha256: requirementSet.sha256, validation: requirementSet.validation.status },
      verification: { resultId: comparison.resultId, versionId: comparison.versionId, sha256: comparison.sha256, validation: comparison.validation.status, review: reviewed.review?.decision ?? null },
      drafting: {
        inputId: savedInput.input.inputId, inputVersionId: savedInput.input.versionId, inputSha256: savedInput.input.sha256,
        draft: { resultId: draft.resultId, versionId: draft.versionId, sha256: draft.sha256, validation: draft.validation.status },
      },
      export: { resultId: exportRef.resultId, exportId: exportRef.exportId, sha256: exportFileSha, size: exportObject.bytes.byteLength, resultSha256: exportRef.sha256, objectKey: exportObjectKeyValue },
      task: { id: submitted.task.id, kind: "bid-verification", state: execution.outcome },
      deletionProject: { id: deletionProject.id, name: deletionProject.name, material: { ...deletionMaterial } },
      objectKeys,
      passwordsInEnvOnly: true,
    }
    writePrivateJson(checkpointPath, checkpoint)
    printJson({
      ok: true,
      root,
      databasePath,
      checkpointPath,
      projectId: project.id,
      deletionProjectId: deletionProject.id,
      materials: 2,
      results: { requirementSet: requirementSet.resultId, verification: comparison.resultId, draft: draft.resultId },
      exportId: exportRef.exportId,
      taskId: submitted.task.id,
      objectCount: objectKeys.length,
      elapsedMs: Date.now() - startedAt,
      note: "synthetic local seed (SQLite + file object store); password is passed via env/args only",
    })
  } finally {
    await database.close()
  }
}

// ---------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------

/** Checksums frozen by src/server/database/migrations.test.ts (0001 + 0004—0012). */
const frozenMigrationChecksums: Record<string, string> = {
  "0004": "e5cd6fdbc6534c3586f1bd5ffecdc3f0306d76c78a231181e3c599e5175cc185",
  "0005": "9677479c49ed95563d2e3330a777b20371ea5bc87b07db4144b4f0d9715e541c",
  "0006": "e6422725f6e246dfd57c8d139c885088f9ad22ef61a97c8dc11f04b588a03edf",
  "0007": "e8ba3f8045d08bf2e195380882d060b50d887555870557d40686f0080d3dece9",
  "0008": "096250a9eab4a2c83dbb5fb71b9c2020e0333e352a8de050571bf3bbab319931",
  "0009": "4c089b83ade96dc63d45cb3a81bdbf24e80dd28a30aeabbe581dc2b989dffd59",
  "0010": "3ad73b6d9013d5d21183e30fca67742a8c5baefe4b6c1c0d591736e91b45aed8",
  "0011": "846cb0abee7b1282024d34e5c5f98405b0db5d5a443bbc4b24ba334505ccb64e",
  "0012": "a3550648bf78ff0fc40e30eea4b00406d72d16661dda673fba799dfe8b27ee36",
}
const frozen0001 = "b6d5889230e98eeacebe62e7ee5604d6e036b93c4e67b57bf10bdd05ce3bba8a"

async function migrations(options: Options): Promise<void> {
  const startedAt = Date.now()
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  const checks: string[] = []
  try {
    const checksum = (migration: { id: string; statements: readonly string[] }) => createHash("sha256").update(JSON.stringify(migration)).digest("hex")
    // 1) empty database applies exactly the registered sequence.
    await migrateBusiness(database)
    const first = (await database.transaction(c => c.query("SELECT id,checksum FROM equilens_business_migrations ORDER BY id"))).rows
    assert.equal(first.length, businessMigrations.length)
    assert.deepEqual(first.map(row => String(row.id)), businessMigrations.map(migration => migration.id))
    for (const row of first) assert.equal(String(row.checksum), checksum(businessMigrations.find(migration => migration.id === String(row.id))!))
    checks.push(`empty-db applies ${first.length} migrations`)
    // 2) repeated start is a checksum-only no-op.
    await migrateBusiness(database)
    const second = (await database.transaction(c => c.query("SELECT id,checksum FROM equilens_business_migrations ORDER BY id"))).rows
    assert.deepEqual(second, first)
    checks.push("repeat start: ledger unchanged")
    // 3) frozen 0001 + 0004—0012 drifts are rejected by test-frozen checksums.
    assert.equal(checksum(businessMigrations[0]!), frozen0001, "0001 checksum changed")
    for (const [id, digest] of Object.entries(frozenMigrationChecksums)) {
      const migration = businessMigrations.find(row => row.id === id)
      assert.ok(migration, `缺少迁移 ${id}`)
      assert.equal(checksum(migration!), digest, `迁移 ${id} 已变化；应追加新迁移而不是修改历史`)
    }
    checks.push("frozen checksums 0001 + 0004—0012 unchanged")
    const includes0013 = businessMigrations.some(migration => migration.id === "0013")
    if (includes0013) checks.push("0013 present in ledger (new migration appended by the C7 round; not covered by the frozen 0004—0012 constants)")
    // 4) history drift and out-of-sequence definitions are rejected.
    await assert.rejects(migrateBusiness(database, businessMigrations.map((migration, index) => index === 0 ? { ...migration, statements: ["SELECT 1"] } : migration)), /history mismatch/)
    await assert.rejects(migrateBusiness(database, businessMigrations.slice(0, 1)), /sequence|history mismatch/)
    checks.push("drift history + truncated sequence rejected")
    // 5) a failing new migration rolls schema and ledger back together.
    const nextId = String(businessMigrations.length + 1).padStart(4, "0")
    await assert.rejects(migrateBusiness(database, [...businessMigrations, { id: nextId, statements: [
      "CREATE TABLE a5_rollback_synthetic (id INTEGER)",
      "INSERT INTO a5_missing_synthetic_table(id) VALUES (1)",
    ] }]))
    assert.equal((await database.transaction(c => c.query("SELECT name FROM sqlite_master WHERE name='a5_rollback_synthetic'"))).rows.length, 0)
    assert.equal((await database.transaction(c => c.query("SELECT id FROM equilens_business_migrations"))).rows.length, businessMigrations.length)
    checks.push("failing migration rolls back schema + ledger")
    const reference = {
      version: 1,
      generatedAt: new Date().toISOString(),
      count: first.length,
      includes0013,
      migrations: first.map(row => ({ id: String(row.id), checksum: String(row.checksum) })),
    }
    const out = option(options, "out")
    if (out) writePrivateJson(resolve(out), reference)
    printJson({ ok: true, checks, count: reference.count, includes0013, elapsedMs: Date.now() - startedAt, reference: out ?? null })
  } finally {
    await database.close()
  }
}

// ---------------------------------------------------------------------------
// capacity-repository (deterministic, controlled clock)
// ---------------------------------------------------------------------------

async function capacity(): Promise<void> {
  const startedAt = Date.now()
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  const checks: string[] = []
  const measurements: Array<{ scenario: string; ms: number }> = []
  const measure = async <T,>(scenario: string, work: () => Promise<T>): Promise<T> => {
    const begin = performance.now()
    try { return await work() } finally { measurements.push({ scenario, ms: Number((performance.now() - begin).toFixed(3)) }) }
  }
  const taskError = (failure: unknown): { status?: number; code?: string; message?: string } => {
    const value = failure as { status?: number; code?: string; message?: string }
    return { status: value?.status, code: value?.code, message: value?.message }
  }
  const capture = async (work: () => Promise<unknown>): Promise<{ status?: number; code?: string; message?: string } | null> => {
    try { await work(); return null } catch (failure) { return taskError(failure) }
  }
  try {
    await migrateBusiness(database)
    let clock = new Date("2026-10-29T00:00:00.000Z")
    const budget = new TaskBudgetRepository(database, { now: () => clock })
    const tasks = new TaskRepository(database, { now: () => clock, budget })
    const owners = Array.from({ length: 5 }, () => randomUUID())
    const projectId = randomUUID()
    const request = (index: number) => ({
      kind: "material-parse", projectId,
      refs: { materials: [{ materialVersionId: randomUUID(), sha256: createHash("sha256").update(String(index)).digest("hex") }] },
      conditions: {},
    })
    // Production limits the harness asserts against (no test-only executor switches).
    assert.equal(taskLimits.maxUnfinishedPerOwner, 2)
    assert.equal(taskLimits.maxQueued, 10)
    checks.push("production taskLimits: per-user 2 unfinished, global queue 10")

    const requests = Array.from({ length: 24 }, (_, index) => request(index))
    // Per-user boundary first: owner[0] submits two, the third is refused with 429.
    const first = await measure("submit-first-two", async () => [
      await tasks.submit(owners[0]!, `cap-a-1`, requests[1]!),
      await tasks.submit(owners[0]!, `cap-a-2`, requests[2]!),
    ])
    assert.ok(first.every(result => result.created))
    const perUserError = await measure("submit-per-user-over-limit", () => capture(() => tasks.submit(owners[0]!, `cap-a-3`, requests[3]!)))
    assert.equal(perUserError?.status, 429)
    assert.match(String(perUserError?.message), /每人|最多保留/)
    assert.equal((await tasks.list(owners[0]!)).length, 2)
    checks.push("per-user unfinished limit -> HTTP 429, row not inserted")

    // Global queue boundary: fill to 10, the 11th is refused with 429 before insert.
    for (const owner of owners.slice(1)) {
      await tasks.submit(owner, `cap-b-${owner.slice(0, 8)}-1`, requests[10]!)
      await tasks.submit(owner, `cap-b-${owner.slice(0, 8)}-2`, requests[11]!)
    }
    const queuedTotal = await database.transaction(c => c.query("SELECT COUNT(*) AS n FROM equilens_tasks WHERE state='queued'"))
    assert.equal(Number((queuedTotal.rows[0] as { n: number }).n), 10)
    const queueError = await measure("submit-global-queue-over-limit", () => capture(() => tasks.submit(owners[0]!, `cap-queue-overflow`, requests[12]!)))
    assert.equal(queueError?.status, 429)
    assert.match(String(queueError?.message), /队列已满/)
    assert.equal(Number((await database.transaction(c => c.query("SELECT COUNT(*) AS n FROM equilens_tasks"))).rows[0]?.n), 10)
    checks.push("global queued limit 10 -> HTTP 429, queue unchanged")

    // Idempotent submission: same owner+project+operationId+input returns the original
    // row before any admission count is applied; a different input conflicts.
    const idempotent = await measure("submit-idempotent-repeat", () => tasks.submit(owners[0]!, "cap-a-1", requests[1]!))
    assert.equal(idempotent.created, false)
    assert.equal(idempotent.task.id, first[0]!.task.id)
    const conflict = await measure("submit-idempotency-conflict", () => capture(() => tasks.submit(owners[0]!, "cap-a-1", requests[7]!)))
    assert.equal(conflict?.status, 409)
    assert.equal(conflict?.code, "CONFLICT")
    checks.push("same operationId+input idempotent; different input -> HTTP 409")

    // Single global runner lease: only one claimant; expired lease can recover the same row.
    const claimed = await tasks.claimNext()
    assert.ok(claimed)
    const blocked = await tasks.claimNext()
    assert.equal(blocked, null)
    checks.push("single-runner lease: second claim returns null while lease held")
    clock = new Date(clock.getTime() + taskLimits.leaseMs + 1000)
    const recovered = await tasks.claimNext()
    assert.equal(recovered?.id, claimed!.id)
    assert.equal(recovered?.attempt, claimed!.attempt + 1)
    checks.push("expired lease: same running row recovered with a new attempt/token")
    await tasks.finish(recovered!, { state: "success", resultSummary: JSON.stringify({ capacity: "synthetic" }) })
    const next = await tasks.claimNext()
    assert.ok(next)
    checks.push("finished task releases the lease for the next queued task")

    printJson({
      ok: true,
      checks,
      measurements,
      totalElapsedMs: Date.now() - startedAt,
      limits: { maxUnfinishedPerOwner: taskLimits.maxUnfinishedPerOwner, maxQueued: taskLimits.maxQueued },
      note: "deterministic repository-level capacity boundaries; synthetic local SQLite, controlled clock. Not a SLA or production capacity claim.",
    })
  } finally {
    await database.close()
  }
}

// ---------------------------------------------------------------------------
// capacity-http (requires a running local server)
// ---------------------------------------------------------------------------

async function capacityHttp(options: Options): Promise<void> {
  const databasePath = resolve(requiredOption(options, "database"))
  const checkpointPath = resolve(requiredOption(options, "checkpoint"))
  const base = (option(options, "base") ?? "http://127.0.0.1:3000").replace(/\/+$/, "")
  const password = option(options, "password") ?? process.env.A5_SEED_PASSWORD ?? seedPassword
  const checkpoint = JSON.parse(await (await import("node:fs/promises")).readFile(checkpointPath, "utf8")) as { project: { id: string } }
  const database = await connectDatabase({ provider: "sqlite", path: databasePath })
  const accounts: Array<{ username: string; token?: string }> = []
  try {
    const auth = new AuthService(database)
    const projectRepository = new ProjectRepository(database)
    for (let index = 1; index <= 5; index++) {
      const username = `a5cap${index}`
      if (!(await projectRepository.findAccount(username))) {
        await auth.maintain({ action: "create", username, password, actor: "a5-capacity" })
      }
      const identity: AuthIdentity = { account: (await auth.account((await auth.login(username, password, "deployment")).user.id))!, session: { id: "capacity", expiresAt: 0 } }
      const account = await projectRepository.findAccount(username)
      if (!account) throw new Error("容量账号缺失")
      const member = await projectRepository.findMember(checkpoint.project.id, identity.account.id)
      if (!member) await projectRepository.addMember(checkpoint.project.id, account, "admin", identity.account.id)
      accounts.push({ username })
    }
  } finally { await database.close() }

  async function request(cookie: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; ms: number; json: unknown }> {
    const begin = performance.now()
    const headers: Record<string, string> = { origin: base, cookie }
    let body: string | undefined
    if (init.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(init.body) }
    const response = await fetch(`${base}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "error", cache: "no-store" })
    let json: unknown = null
    try { json = await response.json() } catch { json = null }
    return { status: response.status, ms: Number((performance.now() - begin).toFixed(2)), json }
  }

  const logins = await Promise.all(accounts.map(async account => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ username: account.username, password }), redirect: "error", cache: "no-store",
    })
    const cookies = response.headers.getSetCookie()
    if (!response.ok || !cookies.length) throw new Error(`容量账号登录失败：${account.username} HTTP ${response.status}`)
    return { username: account.username, cookie: cookies[0].split(";")[0] }
  }))
  const checks: string[] = []
  const latencies: number[] = []
  const statusCounts: Record<string, number> = {}
  const failures: Array<{ username: string; label: string; status: number; expected: number }> = []
  const startedAt = Date.now()
  const load = await Promise.all(logins.map(async (login, index) => {
    const reads = await Promise.all([
      request(login.cookie, "/api/projects"),
      request(login.cookie, `/api/projects/${checkpoint.project.id}`),
      request(login.cookie, `/api/projects/${checkpoint.project.id}/materials`),
      request(login.cookie, `/api/projects/${checkpoint.project.id}/results`),
      request(login.cookie, `/api/projects/${checkpoint.project.id}/budget`),
      request(login.cookie, `/api/tasks?projectId=${checkpoint.project.id}`),
    ])
    // Parallel write path: each synthetic user creates its own synthetic project.
    const write = await request(login.cookie, "/api/projects", {
      method: "POST",
      body: {
        name: `A5 容量合成项目 ${index + 1}`, source: "synthetic", sourceReference: "第六轮 A5 容量合成样本",
        purpose: "5 用户并发容量测量", retentionUntil: shanghaiDay(30),
      },
    })
    const results = [...reads, write]
    const expectations = [200, 200, 200, 200, 200, 200, 201]
    results.forEach((result, resultIndex) => {
      latencies.push(result.ms)
      const key = String(result.status)
      statusCounts[key] = (statusCounts[key] ?? 0) + 1
      if (result.status !== expectations[resultIndex]) failures.push({ username: login.username, label: resultIndex === 6 ? "project-create" : `read-${resultIndex}`, status: result.status, expected: expectations[resultIndex]! })
    })
    return {
      username: login.username,
      statuses: results.map(result => result.status),
      maxMs: Math.max(...results.map(result => result.ms)),
      // Usage counters exposed through the existing budget/tasks views (no hidden cost model).
      usage: { budget: reads[4]!.json, tasks: reads[5]!.json },
    }
  }))
  const sorted = [...latencies].sort((left, right) => left - right)
  const percentile = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0
  if (!failures.length) checks.push("5 synthetic users x parallel read + project-create all returned expected statuses")
  printJson({
    ok: failures.length === 0,
    checks,
    accounts: logins.map(login => login.username),
    requests: latencies.length,
    statusCounts,
    failures,
    latencyMs: { min: sorted[0] ?? null, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null },
    wallMs: Date.now() - startedAt,
    load,
    notes: ["5 synthetic users x parallel view/task/budget reads + one project create each on local Windows/SQLite/dev-file-store; no SLA/capacity claim.",
      "This helper writes the 5 synthetic accounts/memberships directly (private CLI); it is a local measurement, not production capacity proof."],
  })
  if (failures.length) throw new Error(`capacity HTTP unexpected statuses: ${JSON.stringify(failures.slice(0, 5))}`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printJson(value: unknown): void { console.log(JSON.stringify(value, null, 2)) }

const { command, options } = parseArgs(process.argv.slice(2))
const runner: Promise<void> = command === "seed" ? seed(options)
  : command === "migrations" ? migrations(options)
    : command === "capacity-repository" ? capacity()
      : command === "capacity-http" ? capacityHttp(options)
        : (() => { throw new Error(`未知子命令：${command}（可选 seed|migrations|capacity-repository|capacity-http）`) })()

runner.catch(failure => {
  console.error(`FAIL ${failure instanceof Error ? failure.message : String(failure)}`)
  if (failure instanceof Error && failure.stack) console.error(failure.stack)
  process.exitCode = 1
})
