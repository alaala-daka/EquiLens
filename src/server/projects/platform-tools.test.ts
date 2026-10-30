import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { connectDatabase } from "../database/connection"
import { migrateBusiness } from "../database/migrations"

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "equilens-platform-tools-"))
  const database = join(root, "live.sqlite")
  const objects = join(root, "objects"), journal = join(root, "journal"), set = join(root, "set")
  for (const path of [objects, journal, set, join(set, "objects")]) mkdirSync(path)
  const db = new DatabaseSync(database)
  db.exec("CREATE TABLE equilens_business_migrations(id TEXT,checksum TEXT); CREATE TABLE equilens_tasks(state TEXT,stage TEXT,execution_token TEXT,lease_until TEXT,updated_at TEXT); INSERT INTO equilens_tasks VALUES('running','model','live-token','2099-01-01','before'); CREATE TABLE equilens_task_runner(token TEXT,lease_until TEXT); INSERT INTO equilens_task_runner VALUES('live-runner','2099-01-01');")
  db.close()
  const bytes = readFileSync(database)
  writeFileSync(join(set, "database.sqlite"), bytes)
  writeFileSync(join(set, "manifest.json"), JSON.stringify({ version: 1, kind: "equilens-project-backup-set", quiesced: true, appVersion: "synthetic", templates: [], configNames: ["DATABASE_PROVIDER", "SQLITE_PATH", "APP_ORIGIN", "PROJECT_DELETION_JOURNAL_DIR", "PROJECT_RECLAIM_BATCH", "PROJECT_LIFECYCLE_INTERVAL_MS"], keyRecovery: "synthetic", database: { file: "database.sqlite", sha256: hash(bytes), size: bytes.length }, root: { objects: "objects" }, objects: [], objectCount: 0, migrationLedger: [], journal: { present: false, files: [] } }))
  const run = (script: string, args: string[]) => spawnSync(process.execPath, [resolve("scripts", script), ...args], { encoding: "utf8", timeout: 30000 })
  const online = ["--set", set, "--database", database, "--objects", objects, "--journal", journal, "--use-restored"]
  return { root, database, objects, journal, set, run, online }
}

test("online restore verification preserves live attempts and runner leases", () => {
  const f = fixture()
  try {
    const before = readFileSync(f.database)
    const result = f.run("restore-verify.mjs", f.online)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(f.database), before)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("online verification rejects mutation options before opening the database", () => {
  const f = fixture()
  try {
    const before = readFileSync(f.database)
    for (const flags of [["--inject-stale-attempt"], ["--replay-cli", "scripts/project-lifecycle.mts"], ["--replay-args", "--apply"]]) {
      assert.notEqual(f.run("restore-verify.mjs", [...f.online, ...flags]).status, 0)
      assert.deepEqual(readFileSync(f.database), before)
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("new restore rejects absent latest journal instead of accepting an empty replay set", () => {
  const f = fixture()
  try {
    const args = ["--set", f.set, "--database", join(f.root, "restored.sqlite"), "--objects", join(f.root, "restored-objects"), "--journal", join(f.root, "restored-journal")]
    assert.notEqual(f.run("restore-verify.mjs", args).status, 0)
    assert.notEqual(f.run("restore-verify.mjs", [...args, "--journal-source", join(f.root, "missing")]).status, 0)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

for (const kind of ["material", "document", "export"]) {
  test(`backup refuses missing persisted ${kind} object`, () => {
    const f = fixture()
    try {
      const db = new DatabaseSync(f.database)
      if (kind === "material") db.exec("CREATE TABLE equilens_material_versions(object_key TEXT,sha256 TEXT,size_bytes INTEGER); INSERT INTO equilens_material_versions VALUES('projects/p/missing','" + "a".repeat(64) + "',10)")
      if (kind === "document") { db.exec("CREATE TABLE equilens_project_document_versions(metadata TEXT)"); db.prepare("INSERT INTO equilens_project_document_versions VALUES(?)").run(JSON.stringify({ objectKey: "projects/p/missing", sha256: "a".repeat(64), size: 10 })) }
      if (kind === "export") db.exec("CREATE TABLE equilens_result_exports(object_key TEXT,sha256 TEXT,state TEXT,template_version TEXT,render_version TEXT); INSERT INTO equilens_result_exports VALUES('projects/p/missing','" + "a".repeat(64) + "','ready','t','r')")
      db.close()
      const result = f.run("backup-objects.mjs", ["--database", f.database, "--objects", f.objects, "--journal", f.journal, "--out", join(f.root, "backup")])
      assert.notEqual(result.status, 0, result.stdout)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
}

test("backup checks persisted digests while allowing unfinished upload/export intents", () => {
  const f = fixture()
  try {
    const bytes = Buffer.from("synthetic original"), digest = hash(bytes), key = "projects/p/original"
    mkdirSync(join(f.objects, "projects", "p"), { recursive: true })
    writeFileSync(join(f.objects, key), Buffer.concat([Buffer.from(JSON.stringify({ version: 1, key, sha256: digest, size: bytes.length }) + "\n"), bytes]))
    const db = new DatabaseSync(f.database)
    db.exec("CREATE TABLE equilens_material_versions(object_key TEXT,sha256 TEXT,size_bytes INTEGER); CREATE TABLE equilens_material_upload_intents(object_key TEXT); INSERT INTO equilens_material_upload_intents VALUES('not-written-yet'); CREATE TABLE equilens_project_document_versions(metadata TEXT); CREATE TABLE equilens_result_exports(object_key TEXT,sha256 TEXT,state TEXT,template_version TEXT,render_version TEXT)")
    db.prepare("INSERT INTO equilens_material_versions VALUES(?,?,?)").run(key, digest, bytes.length)
    db.prepare("INSERT INTO equilens_project_document_versions VALUES(?)").run(JSON.stringify({ objectKey: key, sha256: digest, size: bytes.length }))
    db.prepare("INSERT INTO equilens_result_exports VALUES(?,?,'ready','t','r')").run(key, digest)
    db.exec("INSERT INTO equilens_result_exports VALUES('not-written-yet','hash','pending','t','r')")
    db.close()
    const args = ["--database", f.database, "--objects", f.objects, "--journal", f.journal]
    const good = f.run("backup-objects.mjs", [...args, "--out", join(f.root, "good")])
    assert.equal(good.status, 0, good.stderr)
    const corrupt = new DatabaseSync(f.database)
    corrupt.exec("UPDATE equilens_material_versions SET sha256='" + "0".repeat(64) + "'")
    corrupt.close()
    assert.notEqual(f.run("backup-objects.mjs", [...args, "--out", join(f.root, "bad")]).status, 0)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("complete empty-journal restore executes real CLI and refuses missing or malformed latest intents", async () => {
  const root = mkdtempSync(join(tmpdir(), "equilens-complete-restore-"))
  try {
    const database = join(root, "source.sqlite"), objects = join(root, "objects"), journal = join(root, "journal"), set = join(root, "backup")
    mkdirSync(objects); mkdirSync(journal)
    const db = await connectDatabase({ provider: "sqlite", path: database })
    await migrateBusiness(db); await db.close()
    const run = (script: string, args: string[]) => spawnSync(process.execPath, [resolve("scripts", script), ...args], { encoding: "utf8", timeout: 30000 })
    const backup = run("backup-objects.mjs", ["--database", database, "--objects", objects, "--journal", journal, "--out", set])
    assert.equal(backup.status, 0, backup.stderr)
    const args = (name: string) => ["--set", set, "--database", join(root, name + ".sqlite"), "--objects", join(root, name + "-objects"), "--journal", join(root, name + "-journal"), "--journal-source", journal]
    const before = readFileSync(join(set, "database.sqlite"))
    const restored = run("restore-verify.mjs", args("restored"))
    assert.equal(restored.status, 0, restored.stderr + restored.stdout)
    assert.match(restored.stdout, /deletion-journal replay completed/)
    assert.deepEqual(readFileSync(join(set, "database.sqlite")), before)
    const name = "12345678-1234-4234-8234-123456789012.json"
    writeFileSync(join(journal, name), JSON.stringify({ id: name.slice(0, -5), projectId: "12345678-1234-4234-8234-123456789013" }))
    const malformed = run("restore-verify.mjs", args("malformed"))
    assert.notEqual(malformed.status, 0)
    rmSync(join(journal, name))
    const manifest = JSON.parse(readFileSync(join(set, "manifest.json"), "utf8"))
    manifest.journal = { present: true, dir: "deletion-journal", files: [{ name, sha256: "0".repeat(64) }] }
    writeFileSync(join(set, "manifest.json"), JSON.stringify(manifest))
    const missing = run("restore-verify.mjs", args("missing"))
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /最新删除日志缺少或改变/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
