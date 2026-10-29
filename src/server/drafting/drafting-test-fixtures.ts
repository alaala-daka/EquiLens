import { createHash } from "node:crypto"
import type { AuthIdentity } from "../auth/service"
import { connectDatabase, type Database } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { ExportRepository } from "../exports/repository"
import { ExportService, ExportTemplateRegistry } from "../exports/service"
import { MaterialRepository } from "../materials/repository"
import type { ParseCoverage, SourceFragmentRecord } from "../materials/types"
import { ResultRepository } from "../results/repository"
import { ResultService, type ResultAuthorizer } from "../results/service"
import { ResultValidatorRegistry } from "../results/validation"
import { createSyntheticObjectStore, objectKey, type SyntheticObjectStore } from "../storage/obs"
import { applyDraftingSchema } from "../templates/schema"
import { DraftingInputRepository } from "../templates/repository"
import { specialtySubcontractValidator, supplementaryAgreementValidator } from "./validation"
import { DraftingService, type DraftingInputView } from "./service"
import { specialtySubcontractExportTemplate, supplementaryAgreementExportTemplate } from "./export-template"
import type { DraftingTemplateId } from "../templates/catalog"

/**
 * Synthetic SQLite + private-store fixture for C5 tests.
 *
 * Applies business migrations 0001–0010 through the real ledger and then the
 * frozen 0012 drafting DDL directly (the Lead registers 0012 in the integration
 * pass; the fixture must not depend on that registration being committed). The
 * real ResultService is wired with the production machine-only/server-owned
 * sets plus the C5 validators, so draft generation exercises the production
 * server-owned result path — never a divergent in-test shortcut.
 */
export const projectId = "11111111-1111-4111-8111-111111111111"
export const accountId = "22222222-2222-4222-8222-222222222222"
export const nowIso = "2026-10-29T00:00:00.000Z"
export const fixedNow = () => new Date(nowIso)

export const testIdentity = { account: { id: accountId, username: "tester", role: "member" }, session: { id: "session", expiresAt: Date.now() + 3_600_000 } } as AuthIdentity
export const testAuthorizer: ResultAuthorizer = async (_identity, targetProjectId, action) => ({ projectId: targetProjectId, action, role: "editor", identity: testIdentity })

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const uuid = (prefix: string, value: number) => prefix + String(value).padStart(12, "0")

export type FixtureMaterial = { materialId: string; versionId: string; snapshotId: string; sha256: string; title: string }

export type DraftingFixture = {
  database: Database
  store: SyntheticObjectStore
  materials: MaterialRepository
  repository: DraftingInputRepository
  results: ResultService
  service: DraftingService
  projectRetention: string
  fixtureMaterials: FixtureMaterial[]
  addMaterial(texts: string[], options?: { title?: string; coverage?: ParseCoverage; retentionUntil?: string }): Promise<FixtureMaterial>
  saveInput(templateId: DraftingTemplateId, fields: Record<string, string>, options?: { inputId?: string; baseVersionId?: string; operationId?: string; originalContract?: unknown }): Promise<DraftingInputView>
  generateDraft(input?: { inputId?: string; operationId?: string; reason?: string }): Promise<Awaited<ReturnType<ResultService["saveResultRevision"]>>>
  saveSpecialtyDraft(fields?: Record<string, string>): Promise<Awaited<ReturnType<ResultService["saveResultRevision"]>>>
  exportService(templates?: ExportTemplateRegistry): ExportService
  close(): Promise<void>
}

export function specialtyFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "project.name": "测试机电安装项目",
    "project.location": "上海市浦东新区",
    "parties.employer": "测试发包人有限公司",
    "parties.contractor": "测试分包人有限公司",
    "scope.description": "建筑机电安装工程（给排水、电气、暖通）",
    "pricing.mode": "fixed_total",
    "pricing.amount": "1000000.00",
    "payment.terms": "按月计量，经发包人确认后支付已完工程量的 80%",
    "payment.hasPrepayment": "no",
    "duration.startDate": "2026-11-01",
    "duration.endDate": "2027-10-31",
    "duration.days": "365 日历天",
    "quality.standard": "符合国家现行验收规范合格标准",
    "quality.acceptance": "按国家现行验收规范组织验收",
    "dispute.method": "litigation",
    "dispute.seat": "上海市有管辖权的人民法院",
    "signature.date": "2026-10-30",
    ...overrides,
  }
}

export function supplementaryFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "parties.employer": "测试发包人有限公司",
    "parties.contractor": "测试分包人有限公司",
    "change.kind": "payment",
    "change.clause": "原合同第 3 条付款条件",
    "change.content": "调整付款节点并增加一次进度款支付",
    "change.deltaAmount": "50000.00",
    "effect.condition": "经双方签署后生效",
    "signature.date": "2026-11-15",
    ...overrides,
  }
}

export async function setupDrafting(options: { projectRetention?: string; materialRetention?: string } = {}): Promise<DraftingFixture> {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(database)
  // Work before and after the Lead registers migration 0012: apply the frozen
  // drafting DDL directly only when the migration ledger does not contain it.
  const migrationApplied = await database.transaction(async connection =>
    (await connection.query("SELECT id FROM equilens_business_migrations WHERE id='0012'")).rows.length > 0)
  if (!migrationApplied) await applyDraftingSchema(database)
  const projectRetention = options.projectRetention ?? "2099-12-31"
  await database.transaction(async connection => {
    await connection.query(
      "INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision,role) VALUES($1,$2,$3,$4,$5,$6)",
      [accountId, "tester", "x", 1, 1, "member"],
    )
    await connection.query(
      "INSERT INTO equilens_projects(id,name,source,source_reference,purpose,retention_until,status,created_by,created_at,updated_at,deleted_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11)",
      [projectId, "测试项目", "synthetic", "fixture", "工程验证", projectRetention, "active", accountId, nowIso, nowIso, 1],
    )
  })
  const store = createSyntheticObjectStore()
  const materials = new MaterialRepository(database)
  const results = new ResultService(
    new ResultRepository(database),
    new ResultValidatorRegistry(new Map([
      ["specialty-subcontract", specialtySubcontractValidator],
      ["supplementary-agreement", supplementaryAgreementValidator],
    ])),
    new Set(["contract-review", "bid-requirements", "bid-verification", "specialty-subcontract", "supplementary-agreement"]),
    new Set(["bid-requirements", "specialty-subcontract", "supplementary-agreement"]),
  )
  const repository = new DraftingInputRepository(database, fixedNow)
  const service = new DraftingService({ repository, materials, results, readProjectRetention: async () => projectRetention, now: fixedNow })
  let materialCount = 0
  let operationCount = 0
  let latest: DraftingInputView | null = null
  const latestInputView = (): DraftingInputView => {
    if (!latest) throw new Error("drafting fixture has no saved input yet")
    return latest
  }
  const fixtureMaterials: FixtureMaterial[] = []
  const fixture: DraftingFixture = {
    database, store, materials, repository, results, service, projectRetention, fixtureMaterials,
    async addMaterial(texts, materialOptions = {}) {
      materialCount++
      const materialId = uuid("33333333-3333-4333-8333-", materialCount)
      const versionId = uuid("44444444-4444-4444-8444-", materialCount)
      const snapshotId = uuid("55555555-5555-4555-8555-", materialCount)
      const coverage: ParseCoverage = materialOptions.coverage ?? { status: "available", findings: [], pageCount: null, textLength: texts.join("\n").length }
      const bytes = new TextEncoder().encode(`synthetic-drafting-object-${materialCount}-${texts.join("|")}`)
      const sha256 = digest(bytes)
      const key = objectKey({ projectId, materialId, versionId, sha256 })
      await store.put({ key, bytes, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
      const fragments: SourceFragmentRecord[] = texts.map((text, index) => ({
        id: `fragment-${materialCount}-${index}`, projectId, snapshotId, kind: "paragraph", order: index,
        page: null, paragraph: index + 1, headingPath: [], tableIndex: null, row: null, column: null, text,
      }))
      await materials.create({
        material: {
          id: materialId, projectId, title: materialOptions.title ?? `材料 ${materialCount}`,
          fileName: `material-${materialCount}.docx`, format: "docx", sourceKind: "synthetic", sourceReference: "fixture",
          processingAuthorized: true, purpose: "工程验证", retentionUntil: materialOptions.retentionUntil ?? "2099-12-31",
          status: "active", latestRevision: 1, latestVersionId: versionId, createdBy: accountId, createdAt: nowIso,
        },
        version: {
          id: versionId, projectId, materialId, revision: 1, sha256, size: bytes.byteLength,
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          objectKey: key, fileName: `material-${materialCount}.docx`, createdAt: nowIso,
        },
        snapshot: { id: snapshotId, projectId, materialId, versionId, revision: 1, parser: "docx-ooxml", parserVersion: "c2-docx-1", coverage, createdAt: nowIso },
        fragments,
      })
      const material: FixtureMaterial = { materialId, versionId, snapshotId, sha256, title: materialOptions.title ?? `材料 ${materialCount}` }
      fixtureMaterials.push(material)
      return material
    },
    async saveInput(templateId, fields, saveOptions = {}) {
      operationCount++
      const saved = await service.saveInput(testIdentity, testAuthorizer, {
        projectId,
        templateId,
        ...(saveOptions.inputId ? { inputId: saveOptions.inputId } : {}),
        baseVersionId: saveOptions.baseVersionId ?? "",
        operationId: saveOptions.operationId ?? `drafting-input-${operationCount}`,
        fields,
        ...(saveOptions.originalContract === undefined ? {} : { originalContract: saveOptions.originalContract }),
      })
      latest = saved
      return saved
    },
    async generateDraft(generateOptions = {}) {
      operationCount++
      const current = generateOptions.inputId
        ? await service.getInput(testIdentity, testAuthorizer, projectId, generateOptions.inputId)
        : latestInputView()
      return service.generateDraft(testIdentity, testAuthorizer, {
        projectId,
        inputId: current.input.inputId,
        versionId: current.input.versionId,
        sha256: current.input.sha256,
        operationId: generateOptions.operationId ?? `drafting-generate-${operationCount}`,
        reason: generateOptions.reason ?? "生成文书草稿",
      })
    },
    async saveSpecialtyDraft(fields = specialtyFields()) {
      const saved = await fixture.saveInput("specialty-subcontract-v1", fields)
      return fixture.generateDraft({ inputId: saved.input.inputId })
    },
    exportService(templates) {
      return new ExportService(
        new ExportRepository(database), results, store,
        templates ?? new ExportTemplateRegistry(new Map([
          ["specialty-subcontract", specialtySubcontractExportTemplate],
          ["supplementary-agreement", supplementaryAgreementExportTemplate],
        ])),
        async () => projectRetention,
      )
    },
    async close() { await database.close() },
  }
  return fixture
}
