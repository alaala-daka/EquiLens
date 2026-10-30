import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { DatabaseSync, backup } from "node:sqlite"
import { connectDatabase, type Database } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { FactRepository } from "../facts/repository"
import { PaymentLedgerRepository } from "../payments/repository"
import { evidenceSchema } from "../evidence/schema"
import { createSyntheticObjectStore, createUnavailableObjectStore, documentObjectKey, exportObjectKey, objectKey, type PrivateObjectStore, type SyntheticObjectStore } from "../storage/obs"
import { validateProjectDeletionIntent, type ProjectDeletionIntent } from "./deletion-journal"
import { applyProjectLifecycleSchema, PROJECT_RUNTIME_TABLES, PROJECT_SCOPED_TABLES, type ProjectDeletionRecord } from "./lifecycle-schema"
import {
  inspectProjectLifecycle, journalIntentForRecord, projectObjectKeys, reclaimProject, replayProjectDeletionIntents,
} from "./reclamation"
import { ProjectRepository } from "./repository"
import { applyProjectSchema } from "./schema"
import * as reclamation from "./reclamation"
import { createProjectLifecycleRuntime, initializeProjectLifecycle, sweepProjectLifecycle } from "./lifecycle"

const accountId = "00000000-0000-4000-8000-000000000001"
const sha = (value: string) => value.repeat(64).slice(0, 64)
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function memoryJournal() {
  const intents: ProjectDeletionIntent[] = []
  return {
    directory: "memory",
    intents,
    async readIntents() { return intents.map(value => ({ ...value })) },
    async appendIntent(intent: ProjectDeletionIntent) {
      validateProjectDeletionIntent(intent)
      const existing = intents.find(value => value.projectId === intent.projectId)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(intent)) throw new Error("Conflicting project deletion journal")
        return
      }
      intents.push({ ...intent })
    },
  }
}

type SeededProject = { projectId: string; keys: string[]; store: SyntheticObjectStore }

async function seedProject(database: Database, base: number, options: { projectId?: string; withObjects?: boolean } = {}): Promise<SeededProject> {
  const projectId = options.projectId ?? uuid(base)
  const store = createSyntheticObjectStore()
  const keys: string[] = []
  const addObject = async (key: string) => {
    keys.push(key)
    await store.put({ key, bytes: new TextEncoder().encode(`synthetic-${key}`), contentType: "application/octet-stream" })
  }
  const materialId = uuid(base + 1), versionId = uuid(base + 2), snapshotId = uuid(base + 3)
  const materialKey = objectKey({ projectId, materialId, versionId, sha256: sha("a") })
  await addObject(materialKey)
  const intentVersionId = uuid(base + 4)
  const intentKey = objectKey({ projectId, materialId, versionId: intentVersionId, sha256: sha("b") })
  await addObject(intentKey)
  const residueKey = objectKey({ projectId, materialId, versionId: uuid(base + 5), sha256: sha("c") })
  await addObject(residueKey)
  const documentId = uuid(base + 6), documentVersionId = uuid(base + 7)
  const documentKey = documentObjectKey({ projectId, documentId, versionId: documentVersionId, sha256: sha("d") })
  await addObject(documentKey)
  const recordId = uuid(base + 8), taskId = uuid(base + 9), exportId = uuid(base + 10)
  const exportKey = exportObjectKey({ projectId, exportId, sha256: sha("e") })
  await addObject(exportKey)
  const now = "2026-10-20T00:00:00.000Z"
  await database.transaction(async connection => {
    await connection.query("INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision,role) SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS (SELECT 1 FROM equilens_auth_accounts WHERE id=$7)", [accountId, "seed-owner", "x", 1, 1, "member", accountId])
    await connection.query("INSERT INTO equilens_projects(id,name,source,source_reference,purpose,retention_until,status,created_by,created_at,updated_at,deleted_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11)", [projectId, `项目 ${base}`, "authorized", "synthetic", "test", "2099-12-31", "active", accountId, now, now, 1])
    await connection.query("INSERT INTO equilens_project_members(project_id,account_id,role,granted_by,granted_at,revision) VALUES($1,$2,'admin',$3,$4,1)", [projectId, accountId, accountId, now])
    await connection.query("INSERT INTO equilens_project_audit(id,project_id,account_id,action,actor,created_at) VALUES($1,$2,$3,'project.create',$4,$5)", [uuid(base + 11), projectId, accountId, accountId, now])
    await connection.query("INSERT INTO equilens_materials(id,project_id,title,file_name,format,source_kind,source_reference,processing_authorized,purpose,retention_until,status,latest_revision,latest_version_id,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [materialId, projectId, "合成材料", "a.docx", "docx", "synthetic", "synthetic", 1, "test", "2099-12-31", "active", 1, versionId, accountId, now])
    await connection.query("INSERT INTO equilens_material_versions(id,project_id,material_id,revision,sha256,size_bytes,content_type,object_key,file_name,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [versionId, projectId, materialId, 1, sha("a"), 10, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", materialKey, "a.docx", now])
    await connection.query("INSERT INTO equilens_parse_snapshots(id,project_id,material_id,version_id,revision,parser,parser_version,coverage,page_count,text_length,coverage_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [snapshotId, projectId, materialId, versionId, 1, "docx", "1", "available", null, 10, JSON.stringify({ status: "available", findings: [], pageCount: null, textLength: 10 }), now])
    await connection.query("INSERT INTO equilens_source_fragments(id,project_id,snapshot_id,kind,order_index,page,paragraph,heading_path,table_index,row_index,column_index,text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [uuid(base + 12), projectId, snapshotId, "paragraph", 0, null, 1, "[]", null, null, null, "合成片段正文"])
    await connection.query("INSERT INTO equilens_material_upload_intents(id,project_id,material_id,version_id,object_key,account_id,source_kind,source_reference,processing_authorized,purpose,retention_until,state,parse_task_id,attempts,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)", [uuid(base + 13), projectId, materialId, intentVersionId, intentKey, accountId, "synthetic", "synthetic", 1, "test", "2099-12-31", "stored", null, 0, now, now])
    await connection.query("INSERT INTO equilens_material_residue(id,project_id,object_key,reason,attempts,created_at,resolved_at) VALUES($1,$2,$3,$4,$5,$6,NULL)", [uuid(base + 14), projectId, residueKey, "synthetic residue", 0, now])
    await connection.query("INSERT INTO equilens_project_documents(project_id,id,current_version_id,metadata) VALUES($1,$2,$3,$4)", [projectId, documentId, documentVersionId, JSON.stringify({ id: documentId, projectId, title: "合成文书", currentVersionId: documentVersionId, createdAt: now, updatedAt: now, materialId, materialVersionId: versionId, copiedFrom: null })])
    await connection.query("INSERT INTO equilens_project_document_versions(project_id,id,document_id,operation_id,input_hash,metadata) VALUES($1,$2,$3,$4,$5,$6)", [projectId, documentVersionId, documentId, "doc-op-1", sha("f"), JSON.stringify({ id: documentVersionId, projectId, documentId, parentId: null, sha256: sha("d"), objectKey: documentKey, size: 10, createdAt: now, operationId: "doc-op-1", inputHash: sha("f"), editorVersion: "1" })])
    await connection.query("INSERT INTO equilens_project_document_writes(id,project_id,object_key,provenance,state,created_at) VALUES($1,$2,$3,$4,$5,$6)", [uuid(base + 15), projectId, documentKey, "{}", "ready", now])
    await connection.query("INSERT INTO equilens_results(id,project_id,kind,current_version_id,created_at) VALUES($1,$2,$3,$4,$5)", [recordId, projectId, "contract-review", uuid(base + 16), now])
    await connection.query("INSERT INTO equilens_result_versions(id,project_id,result_id,base_version_id,operation_id,request_hash,sha256,origin,value_json,machine_json,provenance_json,sources_json,validation_json,reason,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,$10,$11,$12,$13,$14)", [uuid(base + 16), projectId, recordId, "", "review:1", sha("1"), sha("2"), "machine", "{}", "[]", "{}", "reason", accountId, now])
    await connection.query("INSERT INTO equilens_result_reviews(id,project_id,result_id,version_id,review_json,created_at) VALUES($1,$2,$3,$4,$5,$6)", [uuid(base + 17), projectId, recordId, uuid(base + 16), "{}", now])
    await connection.query("INSERT INTO equilens_result_dependencies(id,project_id,result_id,version_id,dependency_kind,dependency_id,dependency_version_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [uuid(base + 18), projectId, recordId, uuid(base + 16), "material", materialId, versionId])
    await connection.query("INSERT INTO equilens_result_exports(id,project_id,result_id,version_id,result_sha256,sha256,object_key,format,template_version,render_version,state,cleanup_attempts,cleanup_attempted_at,purpose,retention_until,snapshot_json,supersedes_id,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL,$17,$18)", [exportId, projectId, recordId, uuid(base + 16), sha("2"), sha("e"), exportKey, "docx", "v1", "v1", "ready", 0, null, "result-export", "2099-12-31", "{}", accountId, now])
    await connection.query("INSERT INTO equilens_tasks(id,kind,owner,project_id,operation_id,request_hash,manifest,manifest_hash,state,stage,created_at,updated_at,expires_at,attempt,max_attempts,calls_used,max_calls,elapsed_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,0,3,0,0,0)", [taskId, "material-parse", accountId, projectId, `task-op-${base}`, sha("3"), "{}", sha("4"), "success", "success", now, now])
    await connection.query("INSERT INTO equilens_task_budget_reservations(task_id,attempt,call_number,project_id,cost_reserved_fen,time_reserved_ms,actual_cost_fen,actual_time_ms,usage_known,status,created_at,settled_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [taskId, 0, 1, projectId, 0, 0, 0, 0, 1, "settled", now, now])
    await connection.query("INSERT INTO equilens_project_budgets(project_id,cost_limit_fen,cost_reserved_fen,cost_charged_fen,registered_by,registered_at,updated_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [projectId, 1000, 0, 0, accountId, now, now, 1])
    await connection.query("INSERT INTO equilens_ocr_runs(id,project_id,material_id,version_id,certificate_kind,state,calls_used,created_by,started_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [uuid(base + 19), projectId, materialId, versionId, "synthetic", "succeeded", 1, accountId, now, now])
    await connection.query("INSERT INTO equilens_verification_fields(id,project_id,material_id,version_id,subject_key,field_key,label,value_text,normalized_value,origin,revision,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [uuid(base + 20), projectId, materialId, versionId, "subject", "field", "标签", "值", "值", "manual", 1, accountId, now])
    await connection.query("INSERT INTO equilens_verification_records(id,project_id,requirement_set_version_id,requirement_id,subject,certificate_no,source,queried_at,query_conditions_json,conclusion,proof_material_version_id,sha256,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [uuid(base + 21), projectId, uuid(base + 22), "req-1", "主体", "证号", "来源", now, "{}", "pending", versionId, sha("5"), accountId, now])
    await connection.query("INSERT INTO equilens_drafting_inputs(id,project_id,kind,current_version_id,created_at) VALUES($1,$2,$3,$4,$5)", [uuid(base + 23), projectId, "specialty-subcontract", uuid(base + 24), now])
    await connection.query("INSERT INTO equilens_drafting_input_versions(id,input_id,project_id,kind,version,base_version_id,operation_id,request_hash,sha256,payload_json,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [uuid(base + 24), uuid(base + 23), projectId, "specialty-subcontract", 1, "", `draft-${base}`, sha("6"), sha("7"), "{}", accountId, now])
  })
  if (options.withObjects === false) return { projectId, keys: [], store }
  return { projectId, keys, store }
}

async function copyObjects(source: SyntheticObjectStore, target: SyntheticObjectStore): Promise<void> {
  for (const key of source.keys()) {
    const value = await source.get(key)
    if (value) await target.put({ key, bytes: value.bytes, contentType: value.contentType })
  }
}

async function setupDatabase(): Promise<Database> {
  const database = await connectDatabase({ provider: "sqlite", path: ":memory:" })
  await migrateBusiness(database)
  await applyProjectSchema(database)
  await applyProjectLifecycleSchema(database)
  return database
}

test("C7 recovery: startup resumes interrupted reclamation without repeating cleared objects or online takeover", async () => {
  const database = await setupDatabase()
  try {
    const seeded = await seedProject(database, 8000)
    const repository = new ProjectRepository(database)
    await repository.delete(seeded.projectId, accountId)
    const journal = memoryJournal()
    let deletes = 0
    const store = { ...seeded.store, async delete(key: string) { deletes++; await seeded.store.delete(key) } }
    // Model a process crash after one object deletion and its durable checkpoint.
    await database.transaction(async connection => {
      await connection.query("UPDATE equilens_project_deletions SET state='reclaiming' WHERE project_id=$1", [seeded.projectId])
      await connection.query("INSERT INTO equilens_project_reclamations(id,project_id,object_key,state,attempts,created_at,updated_at,cleared_at) VALUES($1,$2,$3,'cleared',1,$4,$5,$6)", [uuid(8099), seeded.projectId, seeded.keys[0], "2026-10-20T00:00:00.000Z", "2026-10-20T00:00:00.000Z", "2026-10-20T00:00:00.000Z"])
    })
    await seeded.store.delete(seeded.keys[0])
    assert.equal((await reclaimProject(database, seeded.projectId, { journal, store })).state, "pending")
    assert.equal(deletes, 0)
    const blockedJournal = { ...journal, async appendIntent() { throw new Error("journal unavailable") } }
    assert.equal((await reclaimProject(database, seeded.projectId, { journal: blockedJournal, store })).state, "pending")
    assert.equal((await repository.deletionRecord(seeded.projectId))?.state, "reclaiming", "a caller without the claim cannot fail another execution")
    assert.equal(await reclamation.recoverInterruptedProjectReclamations(database), 1)
    assert.equal((await reclaimProject(database, seeded.projectId, { journal: blockedJournal, store })).error, "JOURNAL_UNAVAILABLE")
    assert.equal(deletes, 0)
    await database.transaction(connection => connection.query("UPDATE equilens_project_deletions SET state='reclaiming' WHERE project_id=$1", [seeded.projectId]))
    const context = { database, journal, store, batch: 10, now: () => new Date("2026-10-20T00:00:00.000Z") }
    const runtime = createProjectLifecycleRuntime({ initialize: () => initializeProjectLifecycle(context), sweep: () => sweepProjectLifecycle(context), schedule: () => () => {} })
    try {
      runtime.start()
      await runtime.ready()
      assert.equal((await repository.deletionRecord(seeded.projectId))?.state, "reclaimed")
    } finally { await runtime.stop() }
    assert.equal(deletes, seeded.keys.length - 1)
    assert.equal(await reclamation.recoverInterruptedProjectReclamations(database), 0)
  } finally { await database.close() }
})

test("C7 lifecycle: periodic sweeps reconcile a bounded backlog of more than 100 recordless deleted projects", async () => {
  const database = await setupDatabase()
  try {
    const repository = new ProjectRepository(database)
    await database.transaction(async connection => {
      await connection.query("INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision,role) VALUES($1,'legacy-owner','x',1,1,'member')", [accountId])
      for (let index = 0; index < 101; index++) {
        await connection.query("INSERT INTO equilens_projects(id,name,source,source_reference,purpose,retention_until,status,created_by,created_at,updated_at,deleted_at,revision) VALUES($1,'legacy','synthetic','test','test','2099-12-31','deleted',$2,$3,$4,$5,1)", [uuid(9000 + index), accountId, "2026-10-20T00:00:00.000Z", "2026-10-20T00:00:00.000Z", "2026-10-20T00:00:00.000Z"])
      }
    })
    const context = { database, journal: memoryJournal(), store: createSyntheticObjectStore(), now: () => new Date("2026-10-20T00:00:00.000Z"), batch: 10 }
    await sweepProjectLifecycle(context)
    assert.equal((await repository.listRecordlessDeleted()).length, 1)
    assert.equal(context.journal.intents.length, 100)
    await sweepProjectLifecycle(context)
    assert.equal((await repository.listRecordlessDeleted()).length, 0)
    assert.equal(context.journal.intents.length, 101)
    assert.equal((await repository.deletionRecord(uuid(9100)))?.state, "reclaimed")
  } finally { await database.close() }
})

function countRows(database: Database, table: string, projectId: string): Promise<number> {
  return database.transaction(async connection => Number((await connection.query(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id=$1`, [projectId])).rows[0]?.count ?? 0))
}

function tableExists(database: Database, table: string): Promise<boolean> {
  return database.transaction(async connection => {
    try { await connection.query(`SELECT 1 FROM ${table} WHERE 1=0`); return true }
    catch { return false }
  })
}

/** Windows may briefly keep SQLite WAL files locked after closing; best-effort retry cleanup. */
async function cleanupDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await rm(directory, { recursive: true, force: true }); return }
    catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

test("C7 reclamation: all project objects and scoped rows are removed, other projects and anonymous data stay untouched", async () => {
  const database = await setupDatabase()
  try {
    const first = await seedProject(database, 100)
    const second = await seedProject(database, 300)
    const store = createSyntheticObjectStore()
    await copyObjects(first.store, store)
    await copyObjects(second.store, store)
    await database.transaction(connection => connection.query("INSERT INTO equilens_documents(owner,id,current_revision,metadata) VALUES($1,$2,$3,$4)", [sha("9"), uuid(900), uuid(901), "{}"]))
    const { record } = await new ProjectRepository(database).delete(first.projectId, accountId, "user-delete")
    assert.equal(record.state, "requested")
    const journal = memoryJournal()
    const outcome = await reclaimProject(database, first.projectId, { journal, store, batch: 3 })
    assert.equal(outcome.state, "reclaimed")
    assert.ok(outcome.deletedObjects >= 5)
    assert.ok(outcome.skippedTables.includes("equilens_fact_versions"))
    const saved = (await new ProjectRepository(database).deletionRecord(first.projectId)) as ProjectDeletionRecord
    assert.equal(saved.state, "reclaimed")
    assert.ok(saved.completedAt)
    assert.ok(saved.clearedAt)
    // Every seeded object key for the deleted project is gone; the other project's objects remain.
    for (const key of first.keys) assert.equal(await store.get(key), null)
    for (const key of second.keys) assert.ok(await store.get(key))
    assert.equal((await store.keys()).length, second.keys.length)
    // All project-scoped rows for the deleted project are gone; project row is a tombstone.
    for (const table of PROJECT_SCOPED_TABLES) {
      if (!await tableExists(database, table)) continue
      assert.equal(await countRows(database, table, first.projectId), 0, `row left in ${table}`)
    }
    assert.equal(await countRows(database, "equilens_project_members", first.projectId), 0)
    assert.equal((await database.transaction(connection => connection.query("SELECT status FROM equilens_projects WHERE id=$1", [first.projectId]))).rows.length, 1)
    // Other project rows and the anonymous document are intact.
    for (const table of ["equilens_materials", "equilens_material_versions", "equilens_tasks", "equilens_results"]) {
      assert.equal(await countRows(database, table, second.projectId), 1, `other project row lost in ${table}`)
    }
    assert.equal((await database.transaction(connection => connection.query("SELECT COUNT(*) AS count FROM equilens_documents"))).rows[0].count, 1)
    // Journal kept exactly one durable intent for the project.
    assert.equal(journal.intents.length, 1)
    assert.equal(journal.intents[0].projectId, first.projectId)
    // Replay/reclaim of a completed deletion is an idempotent no-op.
    const again = await reclaimProject(database, first.projectId, { journal, store })
    assert.equal(again.state, "reclaimed")
    assert.equal(again.deletedObjects, 0)
  } finally { await database.close() }
})

test("C7 reclamation: the object inventory is rebuilt from project rows only (no store list API)", async () => {
  const database = await setupDatabase()
  try {
    const first = await seedProject(database, 500)
    const second = await seedProject(database, 700)
    // A foreign object key is never part of this project's inventory.
    const foreign = await (async () => {
      const object = objectKey({ projectId: second.projectId, materialId: uuid(701), versionId: uuid(702), sha256: sha("8") })
      await second.store.put({ key: object, bytes: new TextEncoder().encode("other"), contentType: "text/plain" })
      return object
    })()
    const keys = await projectObjectKeys(database, first.projectId)
    assert.deepEqual(keys, [...first.keys].sort())
    assert.equal(keys.includes(foreign), false)
  } finally { await database.close() }
})

test("C7 guard: every sqlite table with a project_id column is covered by PROJECT_SCOPED_TABLES or the tombstone whitelist", async () => {
  const database = await setupDatabase()
  try {
    // Bootstrap B-line runtime schemas exactly as repositories would.
    await new FactRepository(database).initialize()
    await new PaymentLedgerRepository(database).initialize()
    await database.transaction(async connection => { for (const statement of evidenceSchema) await connection.query(statement) })
    const tables = (await database.transaction(connection => connection.query("SELECT name FROM sqlite_master WHERE type='table'"))).rows.map(row => String(row.name))
    const projectScoped: string[] = []
    for (const table of tables) {
      const columns = (await database.transaction(connection => connection.query(`PRAGMA table_info(${table})`))).rows.map(row => String(row.name))
      if (columns.includes("project_id")) projectScoped.push(table)
    }
    const allowed = new Set([...PROJECT_SCOPED_TABLES, "equilens_project_deletions", "equilens_project_reclamations"])
    const uncovered = projectScoped.filter(table => !allowed.has(table))
    assert.deepEqual(uncovered, [], `project-scoped tables missing from PROJECT_SCOPED_TABLES: ${uncovered.join(", ")}`)
    // Runtime tables are present after initialization and in the frozen list.
    for (const table of PROJECT_RUNTIME_TABLES) assert.ok(tables.includes(table), `${table} should exist after runtime schema bootstrap`)
    // A new project-scoped table without a registration fails the guard.
    await database.transaction(connection => connection.query("CREATE TABLE synthetic_project_scope (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL)"))
    const after = (await database.transaction(connection => connection.query("SELECT name FROM sqlite_master WHERE type='table'"))).rows.map(row => String(row.name))
    const uncoveredAfter = after.filter(table => table.startsWith("synthetic_") && !allowed.has(table) && !table.startsWith("synthetic_rollback"))
    assert.deepEqual(uncoveredAfter, ["synthetic_project_scope"])
  } finally { await database.close() }
})

test("C7 reclamation: a partial object-delete failure keeps the project revoked and retries to completion", async () => {
  const database = await setupDatabase()
  try {
    const project = await seedProject(database, 1000)
    const store = createSyntheticObjectStore()
    await copyObjects(project.store, store)
    const { record } = await new ProjectRepository(database).delete(project.projectId, accountId, "user-delete")
    const journal = memoryJournal()
    await journal.appendIntent(journalIntentForRecord(record))
    // Persistent failure for one object key: the project stays revoked/failed until retried.
    const stuckKey = project.keys[0]
    const partiallyFailing: PrivateObjectStore = {
      put: input => store.put(input),
      get: key => store.get(key),
      async delete(key) {
        if (key === stuckKey) throw new Error("synthetic permanent object delete failure")
        await store.delete(key)
      },
    }
    const failed = await reclaimProject(database, project.projectId, { journal, store: partiallyFailing, batch: 2 })
    assert.equal(failed.state, "failed")
    const failedRecord = (await new ProjectRepository(database).deletionRecord(project.projectId)) as ProjectDeletionRecord
    assert.equal(failedRecord.state, "failed")
    assert.ok(failedRecord.attempts >= 1)
    assert.ok(failedRecord.lastError)
    // Rows are retained until every object is cleared; access already revoked.
    assert.equal(await countRows(database, "equilens_materials", project.projectId), 1)
    assert.equal(await new ProjectRepository(database).findActive(project.projectId), null)
    const retried = await reclaimProject(database, project.projectId, { journal, store, batch: 2 })
    assert.equal(retried.state, "reclaimed")
    assert.equal(await countRows(database, "equilens_materials", project.projectId), 0)
    for (const key of project.keys) assert.equal(await store.get(key), null)
  } finally { await database.close() }
})

test("C7 reclamation: an unconfigured object store fails closed and never deletes rows or reports completion", async () => {
  const database = await setupDatabase()
  try {
    const project = await seedProject(database, 1200)
    const { record } = await new ProjectRepository(database).delete(project.projectId, accountId, "user-delete")
    const journal = memoryJournal()
    await journal.appendIntent(journalIntentForRecord(record))
    const outcome = await reclaimProject(database, project.projectId, { journal, store: createUnavailableObjectStore() })
    assert.equal(outcome.state, "failed")
    const saved = (await new ProjectRepository(database).deletionRecord(project.projectId)) as ProjectDeletionRecord
    assert.equal(saved.state, "failed")
    assert.equal(saved.completedAt, null)
    assert.equal(await countRows(database, "equilens_materials", project.projectId), 1)
    assert.equal((await database.transaction(connection => connection.query("SELECT status FROM equilens_projects WHERE id=$1", [project.projectId]))).rows[0].status, "deleted")
  } finally { await database.close() }
})

test("C7 reclamation: a journal write failure deletes no object and keeps the record retryable", async () => {
  const database = await setupDatabase()
  try {
    const project = await seedProject(database, 1400)
    const store = createSyntheticObjectStore()
    await copyObjects(project.store, store)
    await new ProjectRepository(database).delete(project.projectId, accountId, "user-delete")
    let deletes = 0
    const counting: PrivateObjectStore = {
      put: input => store.put(input),
      get: key => store.get(key),
      async delete(key) { deletes++; await store.delete(key) },
    }
    const failingJournal = { directory: "memory", async readIntents() { return [] }, async appendIntent(): Promise<void> { throw new Error("synthetic journal unavailable") } }
    const outcome = await reclaimProject(database, project.projectId, { journal: failingJournal, store: counting })
    assert.equal(outcome.state, "pending")
    assert.equal(deletes, 0)
    assert.equal(await countRows(database, "equilens_materials", project.projectId), 1)
    const saved = (await new ProjectRepository(database).deletionRecord(project.projectId)) as ProjectDeletionRecord
    assert.equal(saved.state, "requested")
  } finally { await database.close() }
})

test("C7 reclamation: objects cleared but a row-delete failure keeps the project revoked and retries without re-clearing", async () => {
  const database = await setupDatabase()
  try {
    const project = await seedProject(database, 1420)
    const store = createSyntheticObjectStore()
    await copyObjects(project.store, store)
    const { record } = await new ProjectRepository(database).delete(project.projectId, accountId, "user-delete")
    const journal = memoryJournal()
    await journal.appendIntent(journalIntentForRecord(record))
    const failingRows: Database = {
      close: async () => {},
      transaction: work => database.transaction(connection => work({
        async query(sql, values) {
          if (sql.startsWith("DELETE FROM equilens_materials ")) throw new Error("synthetic row delete failure")
          return connection.query(sql, values)
        },
      })),
    }
    const first = await reclaimProject(failingRows, project.projectId, { journal, store })
    assert.equal(first.state, "failed")
    assert.ok(first.deletedObjects >= 5, "objects were cleared before the row-delete failure")
    const failedRecord = (await new ProjectRepository(database).deletionRecord(project.projectId)) as ProjectDeletionRecord
    assert.equal(failedRecord.state, "failed")
    assert.equal(await new ProjectRepository(database).findActive(project.projectId), null)
    assert.equal(await countRows(database, "equilens_materials", project.projectId), 1, "row delete was rolled back")
    // Retry: objects are already cleared; the row deletion now completes.
    const retried = await reclaimProject(database, project.projectId, { journal, store })
    assert.equal(retried.state, "reclaimed")
    assert.equal(await countRows(database, "equilens_materials", project.projectId), 0)
  } finally { await database.close() }
})

test("C7 inspection: metadata/counts only, no project names or object keys", async () => {
  const database = await setupDatabase()
  try {
    const project = await seedProject(database, 1600)
    await new ProjectRepository(database).delete(project.projectId, accountId, "retention-expired")
    const inspection = await inspectProjectLifecycle(database)
    assert.equal(inspection.deletions.length, 1)
    assert.equal(inspection.deletions[0].record.state, "requested")
    assert.equal(inspection.deletions[0].pendingObjects, 0)
    const text = JSON.stringify(inspection)
    assert.equal(text.includes("项目 1600"), false)
    assert.equal(text.includes("projects/"), false)
    assert.equal(text.includes("合成材料"), false)
  } finally { await database.close() }
})

// ---------------------------------------------------------------------------
// Offline restore / replay (old backup must not resurrect a deleted project)
// ---------------------------------------------------------------------------

async function fileDatabase(path: string): Promise<Database> {
  const database = await connectDatabase({ provider: "sqlite", path })
  await migrateBusiness(database)
  await applyProjectSchema(database)
  await applyProjectLifecycleSchema(database)
  return database
}

async function backupDatabase(source: Database, path: string, target: string): Promise<void> {
  void source
  const connection = new DatabaseSync(path)
  try { await backup(connection, target) } finally { connection.close() }
}

test("C7 replay: an older backup is revoked and purged from the latest deletion journal (never revived)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-replay-"))
  const livePath = join(directory, "live.sqlite")
  const backupPath = join(directory, "before-delete.sqlite")
  let live: Database | undefined
  let restored: Database | undefined
  try {
    live = await fileDatabase(livePath)
    const first = await seedProject(live, 2000)
    const second = await seedProject(live, 2200)
    const journal = memoryJournal()
    const store = createSyntheticObjectStore()
    await copyObjects(first.store, store)
    await copyObjects(second.store, store)
    await backupDatabase(live, livePath, backupPath)
    // Delete on the live database: revoke + record + journal, then reclaim.
    const repository = new ProjectRepository(live)
    const { record } = await repository.delete(first.projectId, accountId, "user-delete")
    await journal.appendIntent(journalIntentForRecord(record))
    assert.equal((await reclaimProject(live, first.projectId, { journal, store })).state, "reclaimed")
    // Restore the older backup: the project row is active and its objects exist again.
    restored = await fileDatabase(backupPath)
    const restoredRepository = new ProjectRepository(restored)
    assert.ok(await restoredRepository.findActive(first.projectId))
    const restoredStore = createSyntheticObjectStore()
    await copyObjects(first.store, restoredStore)
    await copyObjects(second.store, restoredStore)
    const outcome = await replayProjectDeletionIntents(restored, journal, await journal.readIntents(), { store: restoredStore, batch: 3 })
    assert.equal(outcome.revoked, 1)
    assert.equal(outcome.reclaimed, 1)
    assert.equal(outcome.pending, 0)
    // Deleted project is not visible/revived; its content is gone; the other project is intact.
    assert.equal(await restoredRepository.findActive(first.projectId), null)
    assert.equal(await countRows(restored, "equilens_materials", first.projectId), 0)
    for (const key of first.keys) assert.equal(await restoredStore.get(key), null)
    assert.ok(await restoredRepository.findActive(second.projectId))
    assert.equal(await countRows(restored, "equilens_materials", second.projectId), 1)
    const recordAfter = (await restoredRepository.deletionRecord(first.projectId)) as ProjectDeletionRecord
    assert.equal(recordAfter.state, "reclaimed")
    assert.ok(recordAfter.completedAt)
  } finally {
    await live?.close(); await restored?.close()
    await cleanupDirectory(directory)
  }
})

test("C7 replay: a deletion-after backup replays as an idempotent no-op and touches no other project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-replay-noop-"))
  const livePath = join(directory, "live.sqlite")
  const backupPath = join(directory, "after-delete.sqlite")
  let live: Database | undefined
  let restored: Database | undefined
  try {
    live = await fileDatabase(livePath)
    const deleted = await seedProject(live, 2400)
    const kept = await seedProject(live, 2600)
    const journal = memoryJournal()
    const store = createSyntheticObjectStore()
    await copyObjects(deleted.store, store)
    const repository = new ProjectRepository(live)
    const { record } = await repository.delete(deleted.projectId, accountId, "user-delete")
    await journal.appendIntent(journalIntentForRecord(record))
    assert.equal((await reclaimProject(live, deleted.projectId, { journal, store })).state, "reclaimed")
    await backupDatabase(live, livePath, backupPath)
    restored = await fileDatabase(backupPath)
    const restoredRepository = new ProjectRepository(restored)
    const outcome = await replayProjectDeletionIntents(restored, journal, await journal.readIntents(), { store: createSyntheticObjectStore() })
    assert.equal(outcome.revoked, 0)
    assert.equal(outcome.reclaimed, 0)
    assert.equal(outcome.tombstones, 0)
    assert.equal(await restoredRepository.findActive(deleted.projectId), null)
    assert.ok(await restoredRepository.findActive(kept.projectId))
  } finally {
    await live?.close(); await restored?.close()
    await cleanupDirectory(directory)
  }
})

test("C7 replay: a restored row with a conflicting deletion record rejects the whole replay before changes", async () => {
  const database = await setupDatabase()
  try {
    const project = await seedProject(database, 2800)
    const journal = memoryJournal()
    const intent: ProjectDeletionIntent = {
      version: 1, id: "00000000-0000-4000-8000-000000002899", projectId: project.projectId,
      reason: "user-delete", requestedBy: accountId, requestedAt: "2026-10-20T00:00:00.000Z", retentionUntil: "2099-12-31",
    }
    await journal.appendIntent(intent)
    // Simulate a mismatching record (different requestedBy) that must block replay.
    await database.transaction(connection => connection.query(
      "INSERT INTO equilens_project_deletions(id,project_id,intent_id,reason,state,requested_by,requested_at,retention_until,attempts,last_error,completed_at,cleared_at) VALUES($1,$2,$3,$4,'requested',$5,$6,$7,0,NULL,NULL,NULL)",
      [uuid(2900), project.projectId, intent.id, "user-delete", "another-account", intent.requestedAt, intent.retentionUntil],
    ))
    await assert.rejects(
      replayProjectDeletionIntents(database, journal, await journal.readIntents(), { store: createSyntheticObjectStore() }),
      /Conflicting project deletion record/,
    )
    // No change: the project row is still active (validation happens before revocation).
    assert.ok(await new ProjectRepository(database).findActive(project.projectId))
  } finally { await database.close() }
})

test("C7 replay: a restored database without the project row writes only a reclaimed tombstone and never creates a project", async () => {
  const database = await setupDatabase()
  try {
    const journal = memoryJournal()
    const intent: ProjectDeletionIntent = {
      version: 1, id: "00000000-0000-4000-8000-000000003001", projectId: uuid(3002),
      reason: "retention-expired", requestedBy: "system:retention", requestedAt: "2026-10-20T00:00:00.000Z", retentionUntil: "2026-10-01",
    }
    await journal.appendIntent(intent)
    const outcome = await replayProjectDeletionIntents(database, journal, [intent], { store: createSyntheticObjectStore() })
    assert.equal(outcome.tombstones, 1)
    assert.equal(outcome.revoked, 0)
    const repository = new ProjectRepository(database)
    assert.equal(await repository.findAny(intent.projectId), null)
    assert.equal((await repository.deletionRecord(intent.projectId))?.state, "reclaimed")
  } finally { await database.close() }
})
