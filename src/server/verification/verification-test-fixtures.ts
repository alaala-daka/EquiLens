import { createHash } from "node:crypto"
import type { ProjectExecutionAccess } from "../../lib/business/contracts"
import type {
  BidVerificationValue, RequirementSetValue, VerificationRequirement,
} from "../../lib/business/verification-types"
import type { VerificationFieldKey } from "../../lib/business/verification-fields"
import { VERIFICATION_FIELD_LABELS, normalizeFieldValue } from "../../lib/business/verification-fields"
import type { AuthIdentity } from "../auth/service"
import { connectDatabase, type Database } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { MaterialRepository } from "../materials/repository"
import type { ParseCoverage, SourceFragmentRecord } from "../materials/types"
import { ResultRepository } from "../results/repository"
import { ResultService, type ResultAuthorizer } from "../results/service"
import { ResultValidatorRegistry } from "../results/validation"
import { createSyntheticObjectStore, objectKey, type SyntheticObjectStore } from "../storage/obs"
import { TaskRepository, type ClaimedTask } from "../tasks/repository"
import type { TaskExecutor } from "../tasks/runner-core"
import type {
  BidRequirementsExecutorDependencies, BidVerificationExecutorDependencies,
} from "./executor"
import type { FieldSource, VerificationFieldValue } from "./field-source"
import { VerificationRecordRepository } from "./records-repository"
import { bidRequirementSetValidator } from "./requirements"
import { VerificationService } from "./service"
import { bidVerificationResultValidator } from "./validation"

/**
 * Synthetic SQLite + private-store fixture for C4-VERIFY integration tests.
 *
 * Uses the real business migrations (including 0010) and the real ResultService
 * with the production C4 validators registered, so requirement-set saves and
 * machine comparison writes exercise the production tables. The FieldSource is a
 * deterministic in-memory fake; the cross-package integration test with Agent A's
 * real `OcrRepository` lives in field-integration.test.ts.
 */
export const projectId = "11111111-1111-4111-8111-111111111111"
export const accountId = "22222222-2222-4222-8222-222222222222"
export const nowIso = "2026-10-29T00:00:00.000Z"
export const asOf = "2026-10-29"

export const testIdentity = { account: { id: accountId, username: "tester", role: "member" }, session: { id: "session", expiresAt: Date.now() + 3_600_000 } } as AuthIdentity
export const testAuthorizer: ResultAuthorizer = async (_identity, targetProjectId, action) => ({ projectId: targetProjectId, action, role: "editor", identity: testIdentity })

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const uuid = (prefix: string, value: number) => prefix + String(value).padStart(12, "0")

export type FixtureMaterial = {
  materialId: string
  versionId: string
  snapshotId: string
  sha256: string
  objectKey: string
  title: string
  fragments: Array<{ id: string; text: string; snapshotId: string; materialVersionId: string }>
}

export type FixtureFieldInput = {
  fieldKey: VerificationFieldKey
  valueText: string
  subjectKey?: string
  origin?: "ocr" | "manual" | "material_text"
  confidence?: number | null
}

export type VerificationFixture = {
  database: Database
  repository: MaterialRepository
  store: SyntheticObjectStore
  results: ResultService
  tasks: TaskRepository
  records: VerificationRecordRepository
  service: VerificationService
  projectRetention: string
  materials: FixtureMaterial[]
  fieldValues: VerificationFieldValue[]
  fieldSource: FieldSource
  addMaterial(texts: string[], options?: { title?: string; coverage?: ParseCoverage; retentionUntil?: string }): Promise<FixtureMaterial>
  addFields(material: FixtureMaterial, fields: FixtureFieldInput[]): void
  removeFields(material: FixtureMaterial, fieldKey: VerificationFieldKey): void
  requirementSetValue(material?: FixtureMaterial, overrides?: Partial<VerificationRequirement>): RequirementSetValue
  saveRequirementSet(options?: { value?: RequirementSetValue; resultId?: string; baseVersionId?: string; operationId?: string }): Promise<Awaited<ReturnType<ResultService["saveResultRevision"]>>>
  submitVerificationTask(options: {
    requirementSet: { id: string; versionId: string; sha256: string }
    materials?: Array<{ materialVersionId: string; sha256: string }>
    externalRecords?: Array<{ recordId: string; sha256: string }>
    asOf?: string
    operationId?: string
  }): Promise<ClaimedTask>
  submitRequirementsTask(options?: { materials?: Array<{ materialVersionId: string; sha256: string }>; operationId?: string }): Promise<ClaimedTask>
  /** Simulate the unified runner's terminal write so a fixture can claim the next task. */
  finishJob(job: ClaimedTask, outcome: { outcome: "success" | "partial" | "failed" | "cancelled"; errorCode?: string; errorMessage?: string; resultSummary?: string }): Promise<void>
  executorDependencies(overrides?: Partial<BidVerificationExecutorDependencies>): BidVerificationExecutorDependencies
  requirementsExecutorDependencies(overrides?: Partial<BidRequirementsExecutorDependencies>): BidRequirementsExecutorDependencies
  close(): Promise<void>
}

export async function setupVerification(options: {
  fragments?: string[]
  projectRetention?: string
  materialRetention?: string
} = {}): Promise<VerificationFixture> {
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
      [projectId, "测试项目", "synthetic", "fixture", "工程验证", projectRetention, "active", accountId, nowIso, nowIso, 1],
    )
  })
  const store = createSyntheticObjectStore()
  const repository = new MaterialRepository(database)
  const results = new ResultService(
    new ResultRepository(database),
    new ResultValidatorRegistry(new Map([
      ["bid-requirements", bidRequirementSetValidator],
      ["bid-verification", bidVerificationResultValidator],
      // Test-only kind used to prove C4 list/get kind filtering; never registered in production.
      ["test-result", async () => ({ status: "valid" as const, issues: [] })],
    ])),
    new Set(["contract-review", "bid-requirements", "bid-verification"]),
    new Set(["bid-requirements"]),
  )
  const records = new VerificationRecordRepository(database, () => new Date(nowIso), (() => {
    let recordCount = 0
    return () => uuid("66666666-6666-4666-8666-", ++recordCount)
  })())
  const tasks = new TaskRepository(database)
  const fieldValues: VerificationFieldValue[] = []
  const fieldSource: FieldSource = {
    async values(project: string, materialVersionIds: readonly string[]) {
      if (project !== projectId) return []
      const ids = new Set(materialVersionIds)
      return fieldValues
        .filter(value => ids.has(value.versionId))
        .sort((left, right) => `${left.subjectKey}\u0000${left.fieldKey}`.localeCompare(`${right.subjectKey}\u0000${right.fieldKey}`))
    },
  }
  let materialCount = 0
  let taskCount = 0
  let operationCount = 0
  const fixture: VerificationFixture = {
    database,
    repository,
    store,
    results,
    tasks,
    records,
    projectRetention,
    materials: [],
    fieldValues,
    fieldSource,
    service: new VerificationService({
      materials: repository,
      results,
      records,
      fieldSource,
      readProjectRetention: async () => projectRetention,
      now: () => new Date(nowIso),
    }),
    async addMaterial(texts, materialOptions = {}) {
      materialCount++
      const materialId = uuid("33333333-3333-4333-8333-", materialCount)
      const versionId = uuid("44444444-4444-4444-8444-", materialCount)
      const snapshotId = uuid("55555555-5555-4555-8555-", materialCount)
      const coverage: ParseCoverage = materialOptions.coverage ?? { status: "available", findings: [], pageCount: null, textLength: texts.join("\n").length }
      const bytes = new TextEncoder().encode(`synthetic-verification-object-${materialCount}-${texts.join("|")}`)
      const sha256 = digest(bytes)
      const key = objectKey({ projectId, materialId, versionId, sha256 })
      await store.put({ key, bytes, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
      const fragments: SourceFragmentRecord[] = texts.map((text, index) => ({
        id: `fragment-${materialCount}-${index}`, projectId, snapshotId, kind: "paragraph", order: index,
        page: null, paragraph: index + 1, headingPath: [], tableIndex: null, row: null, column: null, text,
      }))
      await repository.create({
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
      const material: FixtureMaterial = {
        materialId, versionId, snapshotId, sha256, objectKey: key,
        title: materialOptions.title ?? `材料 ${materialCount}`,
        fragments: fragments.map(fragment => ({ id: fragment.id, text: fragment.text, snapshotId, materialVersionId: versionId })),
      }
      fixture.materials.push(material)
      return material
    },
    addFields(material, fields) {
      for (const field of fields) {
        fixture.fieldValues.push({
          materialId: material.materialId,
          versionId: material.versionId,
          subjectKey: field.subjectKey ?? "enterprise",
          fieldKey: field.fieldKey,
          label: VERIFICATION_FIELD_LABELS[field.fieldKey],
          valueText: field.valueText,
          normalizedValue: normalizeFieldValue(field.fieldKey, field.valueText),
          origin: field.origin ?? "material_text",
          sourceSnapshotId: material.snapshotId,
          sourceFragmentId: material.fragments[0]?.id ?? null,
          ocrRunId: null,
          confidence: field.confidence ?? null,
          revision: 1,
          updatedAt: nowIso,
        })
      }
    },
    removeFields(material, fieldKey) {
      for (let index = fixture.fieldValues.length - 1; index >= 0; index--) {
        const value = fixture.fieldValues[index]
        if (value.materialId === material.materialId && value.fieldKey === fieldKey) fixture.fieldValues.splice(index, 1)
      }
    },
    requirementSetValue(material, overrides = {}) {
      const target = material ?? fixture.materials[0]
      const fragment = target.fragments[0]
      const requirements: VerificationRequirement[] = [{
        requirementId: "req-1",
        // The bidder's name; a matched external record binds to this 义务主体.
        subject: "华建机电安装有限公司",
        quote: fragment.text,
        materialVersionId: target.versionId,
        source: { snapshotId: target.snapshotId, fragmentId: fragment.id },
        addendum: { state: "none", note: "" },
        nature: "资格否决",
        field: "subject_name",
        operator: "eq",
        value: "华建机电安装有限公司",
        asOfRule: "task_as_of",
        materialRelation: "企业营业执照",
        group: null,
        status: "confirmed",
        statusNote: "",
        ...overrides,
      }]
      return { schemaVersion: 1, status: "confirmed", requirements, rejected: [], warnings: [], errors: [] }
    },
    async saveRequirementSet(saveOptions = {}) {
      operationCount++
      const first = fixture.materials[0]
      const value = saveOptions.value ?? fixture.requirementSetValue(first)
      return fixture.service.saveRequirementSet(testIdentity, testAuthorizer, {
        projectId,
        ...(saveOptions.resultId ? { resultId: saveOptions.resultId } : {}),
        baseVersionId: saveOptions.baseVersionId ?? "",
        operationId: saveOptions.operationId ?? `requirement-set-${operationCount}`,
        reason: "人工确认要求集",
        value,
      })
    },
    async submitVerificationTask(option) {
      taskCount++
      const refs = {
        materials: option.materials ?? fixture.materials.slice(1).map(material => ({ materialVersionId: material.versionId, sha256: material.sha256 })),
        requirementSet: option.requirementSet,
        externalRecords: option.externalRecords ?? [],
      }
      await tasks.submit(accountId, option.operationId ?? `verification-task-${taskCount}`, {
        kind: "bid-verification",
        projectId,
        refs,
        conditions: { asOf: option.asOf ?? asOf },
      })
      const job = await tasks.claimNext()
      if (!job) throw new Error("verification fixture could not claim the submitted task")
      return job
    },
    async submitRequirementsTask(option = {}) {
      taskCount++
      await tasks.submit(accountId, option.operationId ?? `requirements-task-${taskCount}`, {
        kind: "bid-requirements",
        projectId,
        refs: { materials: option.materials ?? fixture.materials.map(material => ({ materialVersionId: material.versionId, sha256: material.sha256 })) },
        conditions: { externalProcessingConsent: true },
      })
      const job = await tasks.claimNext()
      if (!job) throw new Error("verification fixture could not claim the submitted task")
      return job
    },
    async finishJob(job, outcome) {
      await tasks.finish(job, {
        state: outcome.outcome,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
        ...(outcome.resultSummary ? { resultSummary: outcome.resultSummary } : {}),
      })
    },
    executorDependencies(overrides = {}) {
      return {
        repository,
        records,
        fieldSource,
        results,
        readProjectRetention: async () => projectRetention,
        identityFor: account => ({ account: { id: account, username: "tester", role: "member" }, session: { id: "execution", expiresAt: 0 } }),
        authorize: async ({ projectId: target, action }) => ({ projectId: target, action, role: "editor", account: { id: accountId, username: "tester", role: "member" } } as ProjectExecutionAccess),
        now: () => new Date(nowIso),
        ...overrides,
      }
    },
    requirementsExecutorDependencies(overrides = {}) {
      return {
        repository,
        results,
        readProjectRetention: async () => projectRetention,
        identityFor: account => ({ account: { id: account, username: "tester", role: "member" }, session: { id: "execution", expiresAt: 0 } }),
        authorize: async ({ projectId: target, action }) => ({ projectId: target, action, role: "editor", account: { id: accountId, username: "tester", role: "member" } } as ProjectExecutionAccess),
        extractor: async () => ({ candidates: [] }),
        env: {},
        now: () => new Date(nowIso),
        ...overrides,
      }
    },
    async close() { await database.close() },
  }
  await fixture.addMaterial(options.fragments ?? ["投标人应具有有效的营业执照，并具备安全生产许可证。", "项目负责人须具有一级建造师注册证书。"], {
    title: "测试招标文件", materialRetention: options.materialRetention,
  } as { title?: string })
  await fixture.addMaterial(["证照信息：华建机电安装有限公司，统一社会信用代码 91310000MA1FL0XX2A。"], { title: "测试营业执照" })
  return fixture
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

/** A valid machine comparison value builder usable as a saved value in service tests. */
export function savedVerificationValue(requirements: BidVerificationValue): BidVerificationValue {
  return JSON.parse(JSON.stringify(requirements)) as BidVerificationValue
}
