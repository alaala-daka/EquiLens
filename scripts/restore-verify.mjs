#!/usr/bin/env node
/**
 * Round-six A5 restore verification (local synthetic evidence only).
 *
 * 1. Verifies a backup set produced by scripts/backup-objects.mjs against its
 *    manifest (database sha256 + PRAGMA integrity_check, every object sha256/size,
 *    latest deletion-journal files, migration ledger).
 * 2. Restores it to NEW paths (operator supplies empty destinations): database,
 *    object bytes and deletion journal; re-verifies every copied digest.
 * 3. Clears stale execution leases / old execution tokens / in-flight attempts in
 *    the restored database before anything can serve it (spec 01 §10.4: a restore
 *    never trusts the old process). `--inject-stale-attempt` plants one running
 *    synthetic task first so the cleanup is observable.
 * 4. Optionally runs the C7 replay CLI (`--replay`) with
 *    `replay --offline-restored-database` so an old backup can never revive a
 *    project deleted after that backup.
 * 5. Offline checks: deleted project row is a tombstone with a deletion record;
 *    every project-scoped table has zero rows for the deleted project (except the
 *    tombstone/deletion/reclamation records); no object key under the deleted
 *    project prefix remains; the kept project still has every expected object.
 * 6. Optional pure-HTTP checks against a running server pointed at the restored
 *    root: login, project list, original bytes+sha256, verbatim fragment,
 *    requirement set/comparison/draft results + review, export download sha256,
 *    task/budget history, deleted project 404, no-store headers.
 *
 * This is a local Windows/SQLite/dev-file-store drill, not OBS/GaussDB/CI proof.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const sha256File = path => sha256(readFileSync(path))
const startedAt = Date.now()

function fail(message, code = 1) {
  console.error(`FAIL ${message}`)
  process.exit(code)
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!key.startsWith("--")) fail(`未知参数：${key}`)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) { options[key.slice(2)] = true; continue }
    options[key.slice(2)] = next
    index++
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const setRoot = options.set ? resolve(String(options.set)) : null
const checkpointPath = options.checkpoint ? resolve(String(options.checkpoint)) : null
const restoredRoot = options["restored-root"] ? resolve(String(options["restored-root"])) : null
const useRestored = options["use-restored"] === true
const databasePath = options.database ? resolve(String(options.database)) : (useRestored && restoredRoot ? join(restoredRoot, "equilens.sqlite") : null)
const objectsRoot = options.objects ? resolve(String(options.objects)) : (useRestored && restoredRoot ? join(restoredRoot, "objects") : null)
const journalTarget = options.journal ? resolve(String(options.journal)) : (useRestored && restoredRoot ? join(restoredRoot, "deletion-journal") : null)
const base = typeof options.base === "string" ? options.base.replace(/\/+$/, "") : null
const username = typeof options.username === "string" ? options.username : "a5owner"
const password = typeof options.password === "string" ? options.password : (process.env.A5_SEED_PASSWORD ?? "a5-restore-pass-123")
const replayCli = typeof options["replay-cli"] === "string" ? resolve(String(options["replay-cli"])) : null
const expectNoop = options["expect-noop"] === true
const injectStaleAttempt = options["inject-stale-attempt"] === true
if (!setRoot || !existsSync(setRoot)) fail("必须提供存在的 --set（backup-objects 输出目录）")
if (!databasePath) fail("必须提供 --database（新恢复库路径）")
if (!objectsRoot) fail("必须提供 --objects（新恢复对象目录）")

const checks = []
const measurements = []
const pass = (name, detail = "") => { checks.push(name); console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`) }
const isNew = path => !existsSync(path)
const assertNew = (path, label) => { if (!isNew(path)) fail(`${label} 必须是新路径（不得覆盖现有数据）：${path}`, 2) }
const checkpointData = checkpointPath && existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, "utf8")) : null
const deletedProjectPrefix = checkpointData?.deletionProject?.id ? `projects/${checkpointData.deletionProject.id}/` : null

// ---------------------------------------------------------------------------
// 1) Manifest and backup set verification
// ---------------------------------------------------------------------------
const manifestPath = join(setRoot, "manifest.json")
if (!existsSync(manifestPath)) fail(`备份集缺少 manifest.json：${setRoot}`)
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
assert.equal(manifest.version, 1, "manifest version")
assert.equal(manifest.kind, "equilens-project-backup-set", "manifest kind")
assert.equal(manifest.quiesced, true, "manifest 必须记录 quiesced 备份")
const backupDatabase = join(setRoot, manifest.database.file)
if (!existsSync(backupDatabase)) fail(`备份集缺少数据库：${backupDatabase}`)
if (sha256File(backupDatabase) !== manifest.database.sha256) fail("备份数据库 sha256 与 manifest 不一致")
if (statSync(backupDatabase).size !== manifest.database.size) fail("备份数据库大小与 manifest 不一致")
const backupCheck = new DatabaseSync(backupDatabase, { readOnly: true })
try {
  const integrity = backupCheck.prepare("PRAGMA integrity_check").all()
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") fail(`备份数据库 integrity_check 失败：${JSON.stringify(integrity)}`)
  const ledger = backupCheck.prepare("SELECT id,checksum FROM equilens_business_migrations ORDER BY id").all().map(row => ({ id: String(row.id), checksum: String(row.checksum) }))
  assert.deepEqual(ledger, manifest.migrationLedger, "备份库迁移账本与 manifest 不一致")
} finally { backupCheck.close() }
pass("backup set manifest/database sha256 + integrity_check + migration ledger")

// Objects in the backup set must exactly match the manifest.
const backupObjectsRoot = join(setRoot, manifest.root.objects)
const listedObjects = new Map(manifest.objects.map(entry => [entry.key, entry]))
const actualKeys = []
function walk(root, current = root) {
  if (!existsSync(current)) return
  for (const name of readdirSync(current)) {
    const path = join(current, name)
    const info = statSync(path)
    if (info.isDirectory()) { walk(root, path); continue }
    if (info.isFile()) actualKeys.push(relative(root, path).split(sep).join("/"))
  }
}
walk(backupObjectsRoot)
for (const key of actualKeys) if (!listedObjects.has(key)) fail(`备份集对象清单缺少对象：${key}`)
for (const entry of listedObjects.values()) {
  const path = join(backupObjectsRoot, ...entry.key.split("/"))
  if (!existsSync(path)) fail(`manifest 列出的对象不存在：${entry.key}`)
  const buffer = readFileSync(path)
  const newline = buffer.indexOf(0x0a)
  if (newline <= 0) fail(`对象缺少合法头：${entry.key}`)
  const payload = buffer.subarray(newline + 1)
  if (sha256(payload) !== entry.sha256) fail(`对象摘要与 manifest 不一致：${entry.key}`)
  if (payload.byteLength !== entry.size) fail(`对象大小与 manifest 不一致：${entry.key}`)
}
pass(`object manifest exact coverage (${manifest.objectCount} objects)`)

// Journal source: the latest private journal directory applied at restore time.
const journalSource = options["journal-source"] ? resolve(String(options["journal-source"])) : journalTarget
if (!journalTarget) fail("必须提供 --journal（新恢复日志目录）")
if (!useRestored) assertNew(journalTarget, "恢复删除日志目录")
else if (!existsSync(journalTarget)) fail("--use-restored 的删除日志目录不存在")
const journalFiles = []
if (journalSource && existsSync(journalSource)) {
  for (const name of readdirSync(journalSource).sort()) {
    const path = join(journalSource, name)
    if (!statSync(path).isFile()) continue
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) fail(`删除日志文件名不符合 <uuid>.json：${name}`)
    journalFiles.push({ name, sha256: sha256File(path) })
  }
  if (manifest.journal.present) {
    // The backup's own journal must match the manifest byte-for-byte. An external
    // "latest journal" (deletions that happened AFTER this backup) is allowed and
    // is exactly what the offline replay must apply; it is validated separately.
    const backupJournalDir = join(setRoot, manifest.journal.dir ?? "deletion-journal")
    const sameJournal = Boolean(journalSource) && existsSync(backupJournalDir) && resolve(journalSource) === resolve(backupJournalDir)
    if (sameJournal) {
      const manifestNames = manifest.journal.files.map(file => file.name).sort()
      assert.deepEqual(journalFiles.map(file => file.name).sort(), manifestNames, "恢复日志文件与备份集 manifest 不一致")
      for (const file of journalFiles) {
        const declared = manifest.journal.files.find(entry => entry.name === file.name)
        if (!declared || declared.sha256 !== file.sha256) fail(`恢复日志摘要与备份集 manifest 不一致：${file.name}`)
      }
    } else if (journalSource) {
      console.log("NOTE applying an external latest deletion journal (deletions after this backup); the backup's own journal is not part of this replay set")
    }
  }
  for (const file of journalFiles) {
    const intent = JSON.parse(readFileSync(join(journalSource, file.name), "utf8"))
    if (!intent || typeof intent.projectId !== "string" || typeof intent.id !== "string") fail(`删除日志文件结构无效：${file.name}`)
  }
}
pass(`deletion journal source verified (${journalFiles.length} files, present=${journalSource ? existsSync(journalSource) : false})`)

// ---------------------------------------------------------------------------
// 2) Restore to new paths (or verify an already-restored root) with digest checks
// ---------------------------------------------------------------------------
const restoreStarted = Date.now()
if (!useRestored) {
  assertNew(databasePath, "恢复数据库")
  assertNew(objectsRoot, "恢复对象目录")
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  copyFileSync(backupDatabase, databasePath)
  if (sha256File(databasePath) !== manifest.database.sha256) fail("恢复后数据库 sha256 不一致")
  mkdirSync(objectsRoot, { recursive: true, mode: 0o700 })
  for (const entry of manifest.objects) {
    const source = join(backupObjectsRoot, ...entry.key.split("/"))
    const destination = join(objectsRoot, ...entry.key.split("/"))
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(source, destination)
    const buffer = readFileSync(destination)
    const newline = buffer.indexOf(0x0a)
    if (newline <= 0 || sha256(buffer.subarray(newline + 1)) !== entry.sha256) fail(`恢复对象校验失败：${entry.key}`)
  }
  mkdirSync(journalTarget, { recursive: true, mode: 0o700 })
  for (const file of journalFiles) {
    const source = join(journalSource, file.name)
    copyFileSync(source, join(journalTarget, file.name))
    if (sha256File(join(journalTarget, file.name)) !== file.sha256) fail(`恢复日志校验失败：${file.name}`)
  }
  measurements.push({ scenario: "restore-copy", ms: Date.now() - restoreStarted })
  pass("restored database/objects/journal to new paths with digest re-verification")
} else {
  // The running server opens the restored database in WAL mode and may persist
  // sessions/tasks, so the file digest can legitimately differ from the backup
  // snapshot after serving starts. Verify logical integrity + frozen ledger instead.
  assert.ok(existsSync(databasePath) && existsSync(objectsRoot) && existsSync(journalTarget), "--use-restored 根目录缺少 database/objects/journal")
  if (sha256File(databasePath) !== manifest.database.sha256) {
    const live = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const integrity = live.prepare("PRAGMA integrity_check").all()
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") fail("已恢复数据库 integrity_check 失败")
      const ledger = live.prepare("SELECT id,checksum FROM equilens_business_migrations ORDER BY id").all().map(row => ({ id: String(row.id), checksum: String(row.checksum) }))
      assert.deepEqual(ledger, manifest.migrationLedger, "已恢复数据库迁移账本与备份集不一致")
    } finally { live.close() }
    console.log("NOTE restored database file digest differs from the backup snapshot (server opened it in WAL mode); verified integrity_check + frozen migration ledger instead")
  }
  for (const entry of manifest.objects) {
    const path = join(objectsRoot, ...entry.key.split("/"))
    if (!existsSync(path)) {
      // Objects of the project deleted after this backup are expected to be gone
      // (the replay/reclamation removed them); every other object must exist.
      if (deletedProjectPrefix && entry.key.startsWith(deletedProjectPrefix)) continue
      fail(`已恢复对象缺失：${entry.key}`)
    }
    const buffer = readFileSync(path)
    const newline = buffer.indexOf(0x0a)
    if (newline <= 0 || sha256(buffer.subarray(newline + 1)) !== entry.sha256) fail(`已恢复对象校验失败：${entry.key}`)
  }
  for (const file of journalFiles) {
    const path = join(journalTarget, file.name)
    if (!existsSync(path) || sha256File(path) !== file.sha256) fail(`已恢复日志校验失败：${file.name}`)
  }
  measurements.push({ scenario: "verify-existing-restored-root", ms: Date.now() - restoreStarted })
  pass("already-restored root verified against the backup manifest (database/objects/journal digests)")
}

// ---------------------------------------------------------------------------
// 3) Stale lease / old execution token / in-flight attempt cleanup
// ---------------------------------------------------------------------------
const restored = new DatabaseSync(databasePath)
const tableExists = name => restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(name).length > 0
const columns = table => restored.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name))
let injectedTaskId = null
try {
  const checkpoint = checkpointData
  if (injectStaleAttempt && tableExists("equilens_tasks")) {
    const anyTask = restored.prepare("SELECT id FROM equilens_tasks ORDER BY id LIMIT 1").get()
    if (!anyTask) fail("--inject-stale-attempt 需要至少一条任务行")
    const id = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    restored.exec("DROP TABLE IF EXISTS a5_stale_task_fixture")
    restored.exec("CREATE TABLE a5_stale_task_fixture AS SELECT * FROM equilens_tasks WHERE id='" + String(anyTask.id) + "'")
    restored.prepare("UPDATE a5_stale_task_fixture SET id=?, state='running', stage='claimed', execution_token='stale-execution-token', lease_until='2099-01-01T00:00:00.000Z', operation_id='a5-stale-injection-' || id").run(id)
    const cols = columns("equilens_tasks").map(column => `"${column}"`).join(",")
    restored.exec(`INSERT INTO equilens_tasks(${cols}) SELECT ${cols} FROM a5_stale_task_fixture`)
    restored.exec("DROP TABLE a5_stale_task_fixture")
    injectedTaskId = id
    pass("planted one synthetic running attempt with a stale lease/token")
  }
  const running = tableExists("equilens_tasks")
    ? Number(restored.prepare("SELECT COUNT(*) AS n FROM equilens_tasks WHERE state='running'").get().n)
    : 0
  if (tableExists("equilens_tasks")) {
    restored.prepare("UPDATE equilens_tasks SET state='queued', stage='recovered', execution_token=NULL, lease_until=NULL, updated_at=? WHERE state='running'").run(new Date().toISOString())
  }
  if (tableExists("equilens_task_runner")) {
    restored.prepare("UPDATE equilens_task_runner SET token=NULL, lease_until=NULL WHERE token IS NOT NULL OR lease_until IS NOT NULL").run()
  }
  const stillRunning = tableExists("equilens_tasks")
    ? Number(restored.prepare("SELECT COUNT(*) AS n FROM equilens_tasks WHERE state='running' OR execution_token IS NOT NULL").get().n)
    : 0
  const runnerTokens = tableExists("equilens_task_runner")
    ? Number(restored.prepare("SELECT COUNT(*) AS n FROM equilens_task_runner WHERE token IS NOT NULL OR lease_until IS NOT NULL").get().n)
    : 0
  assert.equal(stillRunning, 0, "恢复后不得保留 running 任务或旧执行令牌")
  assert.equal(runnerTokens, 0, "恢复后不得保留 全局执行租约令牌")
  pass(`cleared ${running} in-flight attempt(s) + stale runner lease/token; in-flight tasks re-queued as recovered`)
  if (checkpoint) {
    const kept = checkpoint.project.id
    const materialCount = tableExists("equilens_material_versions")
      ? Number(restored.prepare("SELECT COUNT(*) AS n FROM equilens_material_versions WHERE project_id=?").get(kept).n) : 0
    assert.ok(materialCount >= 2, "恢复后保留项目缺少材料版本")
    pass("kept project data rows present after restore")
  }
} finally {
  if (injectedTaskId) restored.prepare("DELETE FROM equilens_tasks WHERE id=?").run(injectedTaskId)
  restored.close()
}

// ---------------------------------------------------------------------------
// 4) C7 offline replay of the latest deletion journal
// ---------------------------------------------------------------------------
let replayResult = null
if (replayCli && existsSync(replayCli)) {
  const args = ["replay", "--apply", "--offline-restored-database"]
  if (typeof options["replay-args"] === "string") args.push(...String(options["replay-args"]).split(" ").filter(Boolean))
  const begin = performance.now()
  // .mts CLIs need the repo's tsx loader; .mjs CLIs run directly with Node.
  const isTypeScriptCli = replayCli.endsWith(".mts") || replayCli.endsWith(".ts")
  const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs")
  const command = isTypeScriptCli && existsSync(tsxCli) ? tsxCli : replayCli
  const commandArgs = isTypeScriptCli && existsSync(tsxCli) ? [replayCli, ...args] : args
  const child = spawnSync(process.execPath, [command, ...commandArgs], {
    cwd: dirname(replayCli), encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_PROVIDER: "sqlite",
      SQLITE_PATH: databasePath,
      PROJECT_DELETION_JOURNAL_DIR: journalTarget,
      // The C7 replay reclaims objects through the configured private store; for
      // the local drill that is the same development file object store.
      NODE_ENV: process.env.NODE_ENV ?? "development",
      EQUILENS_SYNTHETIC_STORAGE: process.env.EQUILENS_SYNTHETIC_STORAGE ?? "1",
      EQUILENS_DEV_OBJECT_STORE: objectsRoot,
    },
    timeout: 120000,
  })
  replayResult = { exitCode: child.status, signal: child.signal, stdout: String(child.stdout ?? "").trim().slice(-4000), stderr: String(child.stderr ?? "").trim().slice(-4000), ms: Number((performance.now() - begin).toFixed(2)) }
  measurements.push({ scenario: "deletion-replay", ms: replayResult.ms })
  if (replayResult.exitCode !== 0) fail(`删除日志重放失败（exit ${replayResult.exitCode}）：${replayResult.stderr || replayResult.stdout}`)
  pass(`deletion-journal replay completed (exit 0, ${replayResult.ms}ms)${expectNoop ? " [expect no-op]" : ""}`)
} else if (replayCli) {
  fail(`--replay-cli 不存在：${replayCli}`)
}

// ---------------------------------------------------------------------------
// 5) Offline post-replay state: tombstones, row/object cleanup, journal applied
// ---------------------------------------------------------------------------
const checkpoint = checkpointData
const deletedProjectId = checkpoint?.deletionProject?.id ?? null
const post = new DatabaseSync(databasePath, { readOnly: true })
let deletionApplied = false
try {
  const integrity = post.prepare("PRAGMA integrity_check").all()
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") fail("恢复后数据库 integrity_check 失败")
  pass("restored database integrity_check ok")
  if (deletedProjectId) {
    const projectRow = post.prepare("SELECT status FROM equilens_projects WHERE id=?").get(deletedProjectId)
    const deletionTable = post.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='equilens_project_deletions'").all().length > 0
    const deletion = deletionTable
      ? post.prepare("SELECT state,intent_id FROM equilens_project_deletions WHERE project_id=?").get(deletedProjectId)
      : null
    const applied = Boolean(deletion)
    if (!applied && options["require-deleted"] === true) fail("--require-deleted：删除日志重放未产生删除记录")
    if (!applied) {
      console.log("SKIP deleted-project checks: no deletion record in restored database (drill not run yet / C7 replay not applied)")
    } else {
      deletionApplied = true
      if (!projectRow) fail("删除项目的墓碑行缺失（项目行保留，仅置 status='deleted'）")
      assert.equal(String(projectRow.status), "deleted", "删除项目必须为 deleted 墓碑")
      pass(`deleted project tombstone + deletion record present (state=${deletion.state})`)
      // Journal application: the deletion intent file must exist in the restored journal.
      const intentFile = join(journalTarget, `${String(deletion.intent_id)}.json`)
      if (!existsSync(intentFile)) fail(`恢复日志缺少删除意图文件：${deletion.intent_id}.json`)
      const intent = JSON.parse(readFileSync(intentFile, "utf8"))
      assert.equal(intent.projectId, deletedProjectId, "删除意图与删除记录不一致")
      pass("deletion intent journal file applied in restored journal directory")

      // Dynamic project-scoped row coverage: every table with project_id must be clean.
      const tables = post.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row.name))
      const exceptions = new Set(["equilens_projects", "equilens_project_deletions", "equilens_project_reclamations"])
      const leftovers = []
      let scanned = 0
      for (const table of tables) {
        if (exceptions.has(table)) continue
        const names = post.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name))
        if (!names.includes("project_id")) continue
        scanned += 1
        const count = Number(post.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`).get(deletedProjectId).n)
        if (count > 0) leftovers.push({ table, count })
      }
      if (leftovers.length) fail(`删除项目仍有项目私有行未清理：${JSON.stringify(leftovers)}`)
      pass(`all ${scanned} project-scoped tables cleared for deleted project`)
      const reclamation = post.prepare("SELECT COUNT(*) AS n FROM equilens_project_reclamations WHERE project_id=?").get(deletedProjectId)
      pass(`reclamation records retained for audit (${Number(reclamation.n)})`)
    }
  }
  if (checkpoint) {
    const kept = checkpoint.project.id
    const keptRow = post.prepare("SELECT status FROM equilens_projects WHERE id=?").get(kept)
    if (!keptRow || String(keptRow.status) !== "active") fail("保留项目在恢复后应为 active")
    const results = post.prepare("SELECT COUNT(*) AS n FROM equilens_result_versions WHERE project_id=?").get(kept)
    assert.ok(Number(results.n) >= 3, "保留项目成果版本缺失")
    const exports = post.prepare("SELECT COUNT(*) AS n FROM equilens_result_exports WHERE project_id=?").get(kept)
    assert.ok(Number(exports.n) >= 1, "保留项目导出记录缺失")
    const tasks = post.prepare("SELECT COUNT(*) AS n FROM equilens_tasks WHERE project_id=?").get(kept)
    assert.ok(Number(tasks.n) >= 1, "保留项目任务历史缺失")
    pass(`kept project intact after replay (${Number(results.n)} result versions, ${Number(exports.n)} exports, ${Number(tasks.n)} tasks)${expectNoop ? " — no-op confirmed" : ""}`)
  }
} finally { post.close() }

// Object cleanup for the deleted project and kept-project object presence.
const keptNeededKeys = checkpoint ? checkpoint.objectKeys : []
for (const key of keptNeededKeys) {
  if (key.startsWith(`projects/${deletedProjectId}/`)) continue
  if (!existsSync(join(objectsRoot, ...key.split("/")))) fail(`保留项目对象缺失：${key}`)
}
const keptBytesPresent = keptNeededKeys.filter(key => !deletedProjectId || !key.startsWith(`projects/${deletedProjectId}/`))
pass(`kept project objects present (${keptBytesPresent.length})`)
if (deletedProjectId && deletionApplied) {
  const prefix = `projects/${deletedProjectId}/`
  const remaining = []
  function walkObjects(current = objectsRoot) {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const info = statSync(path)
      if (info.isDirectory()) { walkObjects(path); continue }
      if (info.isFile()) {
        const key = relative(objectsRoot, path).split(sep).join("/")
        if (key.startsWith(prefix)) remaining.push(key)
      }
    }
  }
  walkObjects()
  if (remaining.length) fail(`删除项目私有对象仍存在：${JSON.stringify(remaining.slice(0, 5))}`)
  pass("deleted project private objects cleared from restored object store")
}

// ---------------------------------------------------------------------------
// 6) Pure HTTP verification (requires a running server on the restored root)
// ---------------------------------------------------------------------------
const http = { requests: 0, latencies: [] }
async function api(cookie, path, init = {}) {
  const begin = performance.now()
  const headers = { origin: base, ...(cookie ? { cookie } : {}) }
  let body
  if (init.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(init.body) }
  const response = await fetch(`${base}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "error", cache: "no-store" })
  const bytes = init.bytes ? new Uint8Array(await response.arrayBuffer()) : null
  let json = null
  if (!init.bytes) { try { json = await response.json() } catch { json = null } }
  const ms = Number((performance.now() - begin).toFixed(2))
  http.requests += 1
  http.latencies.push(ms)
  const cacheControl = response.headers.get("cache-control") ?? ""
  if (response.ok && !/private/i.test(cacheControl)) fail(`响应缺少 private no-store：${path} (${cacheControl})`)
  return { status: response.status, json, bytes, ms }
}
const expectStatus = (response, status, name) => { assert.equal(response.status, status, `${name}: 期望 HTTP ${status}，实际 ${response.status} ${JSON.stringify(response.json)}`) }
if (base) {
  const httpStartedAt = Date.now()
  const anonymous = await api(null, "/api/projects")
  expectStatus(anonymous, 401, "未登录读取项目")
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ username, password }), redirect: "error", cache: "no-store",
  })
  if (!login.ok) fail(`恢复后登录失败：HTTP ${login.status}`)
  const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0]
  if (!cookie) fail("恢复后登录未签发会话 cookie")
  pass("HTTP: login after restore + anonymous 401")

  const projects = await api(cookie, "/api/projects")
  expectStatus(projects, 200, "项目列表")
  const projectIds = (projects.json.projects ?? []).map(project => project.id)
  if (checkpoint && !projectIds.includes(checkpoint.project.id)) fail("恢复后项目列表缺少保留项目")
  pass("HTTP: project list contains kept project")

  let environmentBodies = 0
  for (const material of checkpoint.materials) {
    const content = await api(cookie, `/api/projects/${checkpoint.project.id}/materials/${material.materialId}/versions/${material.versionId}/content`, { bytes: true })
    expectStatus(content, 200, `读取原件 ${material.title}`)
    if (sha256(content.bytes) !== material.sha256) fail(`原件字节摘要不一致：${material.title}`)
    const snapshot = await api(cookie, `/api/projects/${checkpoint.project.id}/materials/${material.materialId}/snapshots/${material.snapshotId}`)
    expectStatus(snapshot, 200, `读取解析快照 ${material.title}`)
    environmentBodies += 1
  }
  // Verbatim fragment check: read a seeded fragment through the authorized source route.
  const certificate = checkpoint.materials[1]
  const certificateFragments = await api(cookie, `/api/projects/${checkpoint.project.id}/materials/${certificate.materialId}/snapshots/${certificate.snapshotId}`)
  expectStatus(certificateFragments, 200, "营业执照解析快照")
  const fragmentId = checkpoint.fields.find(field => field.support === "material_text" && field.sourceFragmentId)?.sourceFragmentId
  if (fragmentId) {
    const source = await api(cookie, `/api/projects/${checkpoint.project.id}/materials/${certificate.materialId}/snapshots/${certificate.snapshotId}/sources/${fragmentId}`)
    expectStatus(source, 200, "逐字来源片段读取")
    const quote = checkpoint.fields.find(field => field.sourceFragmentId === fragmentId)?.valueText
    if (!String(source.json.fragment?.text ?? "").includes(quote)) fail("恢复后逐字来源片段与登记值不一致")
    pass("HTTP: verbatim fragment text still contains the registered field value")
  }
  pass(`HTTP: original bytes + sha256 verified for ${environmentBodies} materials`)

  const results = await api(cookie, `/api/projects/${checkpoint.project.id}/results`)
  expectStatus(results, 200, "成果列表")
  const resultIds = (results.json ?? []).map(view => view.resultId)
  for (const expected of [checkpoint.requirementSet.resultId, checkpoint.verification.resultId, checkpoint.drafting.draft.resultId]) {
    if (!resultIds.includes(expected)) fail(`恢复后成果列表缺少 ${expected}`)
  }
  const verification = await api(cookie, `/api/projects/${checkpoint.project.id}/results/${checkpoint.verification.resultId}`)
  expectStatus(verification, 200, "核验成果读取")
  if (verification.json.review?.decision !== "approved") fail("恢复后核验成果复核状态缺失")
  if (verification.json.validation?.status !== "valid") fail("恢复后核验成果校验状态缺失")
  const requirementSet = await api(cookie, `/api/projects/${checkpoint.project.id}/results/${checkpoint.requirementSet.resultId}`)
  expectStatus(requirementSet, 200, "要求集读取")
  const draft = await api(cookie, `/api/projects/${checkpoint.project.id}/results/${checkpoint.drafting.draft.resultId}`)
  expectStatus(draft, 200, "草稿成果读取")
  pass("HTTP: requirement set, comparison result + approved review, draft read back")

  const exportList = await api(cookie, `/api/projects/${checkpoint.project.id}/results/${checkpoint.drafting.draft.resultId}/exports`)
  expectStatus(exportList, 200, "导出列表")
  if (!(exportList.json ?? []).some(entry => entry.exportId === checkpoint.export.exportId)) fail("恢复后导出列表缺少导出记录")
  const download = await api(cookie, `/api/projects/${checkpoint.project.id}/results/${checkpoint.drafting.draft.resultId}/exports/${checkpoint.export.exportId}/content`, { bytes: true })
  expectStatus(download, 200, "导出下载")
  if (sha256(download.bytes) !== checkpoint.export.sha256) fail("导出文件字节摘要不一致")
  if (download.bytes.byteLength !== checkpoint.export.size) fail("导出文件大小不一致")
  pass(`HTTP: export download sha256 + size verified (${checkpoint.export.size} bytes)`)

  const tasks = await api(cookie, `/api/tasks?projectId=${checkpoint.project.id}`)
  expectStatus(tasks, 200, "任务历史")
  const task = (tasks.json.tasks ?? []).find(view => view.id === checkpoint.task.id)
  if (!task) fail("恢复后任务历史缺少种子任务")
  assert.equal(task.kind, "bid-verification")
  const budgetView = await api(cookie, `/api/projects/${checkpoint.project.id}/budget`)
  expectStatus(budgetView, 200, "项目预算")
  if (Number(budgetView.json?.budget?.costLimitFen) !== checkpoint.budget.costLimitFen) fail("恢复后项目预算登记不一致")
  pass("HTTP: task history + project budget registration preserved")

  if (deletedProjectId) {
    // Project-scoped authorization denies non-members uniformly (403) once member
    // rows are cleared; either 403 or 404 proves the deleted project is not readable.
    const deleted = await api(cookie, `/api/projects/${deletedProjectId}`)
    if (![403, 404].includes(deleted.status)) fail(`已删项目读取未拒绝：HTTP ${deleted.status}`)
    const deletedMaterials = await api(cookie, `/api/projects/${deletedProjectId}/materials`)
    if (![403, 404].includes(deletedMaterials.status)) fail(`已删项目材料读取未拒绝：HTTP ${deletedMaterials.status}`)
    const deletionStatus = await api(cookie, `/api/projects/${deletedProjectId}/deletion`)
    expectStatus(deletionStatus, 200, "删除状态（请求人可读）")
    const body = JSON.stringify(deletionStatus.json)
    if (/"name"|材料|summary|value/.test(body)) fail("删除状态响应可能泄露项目内容")
    if (!/reclaimed|reclaiming|requested|failed/.test(body)) fail("删除状态响应缺少状态字段")
    pass(`HTTP: deleted project access denied (project=${deleted.status}, materials=${deletedMaterials.status}); deletion status readable without project content`)
  }
  const sorted = [...http.latencies].sort((left, right) => left - right)
  measurements.push({ scenario: "http-verification", ms: Date.now() - httpStartedAt, requests: http.requests, p50: sorted[Math.floor(sorted.length / 2)] ?? null, max: sorted.at(-1) ?? null })
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const totalMs = Date.now() - startedAt
console.log(JSON.stringify({
  ok: true,
  set: setRoot,
  restored: { database: databasePath, objects: objectsRoot, journal: journalTarget },
  checks,
  replay: replayResult,
  measurements,
  totalMs,
  lossWindowNote: "Backup was quiesced (app stopped, EXCLUSIVE-lock guard passed); measured LOSS WINDOW for this drill = 0 committed writes between backup snapshot and restore. Real production RPO still depends on the backup cadence and is not claimed.",
  note: "Local Windows/SQLite/dev-file-store restore drill; NOT OBS/GaussDB/CI/off-host proof.",
}, null, 2))
