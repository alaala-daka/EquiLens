#!/usr/bin/env node
/**
 * Round-six A5 backup-set tooling (local synthetic evidence only).
 *
 * Builds a *complete* project backup set, not just a database copy:
 *   <out>/database.sqlite          consistent SQLite snapshot (VACUUM INTO)
 *   <out>/objects/<key path>       dev file-object-store bytes (immutable keys)
 *   <out>/deletion-journal/        latest private deletion-journal files (if any)
 *   <out>/manifest.json            {version, root, objects:[{key,sha256,size}],
 *                                   database sha256, journal files, app/template
 *                                   versions, non-sensitive config name list,
 *                                   key-recovery notes, migration ledger}
 *
 * Quiesce guard: the operator must stop the application first. This script tries
 * to take a SQLite EXCLUSIVE write lock; if another writer holds the database the
 * backup aborts instead of silently copying a changing database ("DB-only backup
 * is not enough", and an inconsistent one is worse). The object store is checked
 * byte-by-byte against each object's header SHA-256 while it is copied.
 *
 * This is NOT an OBS/异地 backup: it copies the local development file store
 * (`data/dev-objects` or EQUILENS_DEV_OBJECT_STORE) and the local SQLite file.
 * Real OBS versioning, off-host retention, Docker/Linux fsync and GaussDB are
 * unverified external gaps.
 *
 * Usage:
 *   node scripts/backup-objects.mjs --database data/equilens.sqlite \
 *     --objects data/dev-objects --journal data/project-deletion-journal \
 *     --out backups/a5-<timestamp> [--app-version <git sha>]
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { verifyBackupReferences } from "./backup-references.mjs"

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const sha256File = path => sha256(readFileSync(path))

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
const databasePath = resolve(String(options.database ?? process.env.SQLITE_PATH ?? ""))
const objectsRoot = resolve(String(options.objects ?? process.env.EQUILENS_DEV_OBJECT_STORE ?? ""))
const journalRoot = options.journal ? resolve(String(options.journal)) : null
const outRoot = options.out ? resolve(String(options.out)) : null
const appVersion = typeof options["app-version"] === "string" ? options["app-version"] : (process.env.EQUILENS_APP_VERSION ?? "unknown")
if (!options.database && !process.env.SQLITE_PATH) fail("必须提供 --database（或 SQLITE_PATH）")
if (!options.objects && !process.env.EQUILENS_DEV_OBJECT_STORE) fail("必须提供 --objects（或 EQUILENS_DEV_OBJECT_STORE）")
if (!outRoot) fail("必须提供 --out（新备份目录）")
if (!existsSync(databasePath)) fail(`数据库不存在：${databasePath}`, 2)
if (!existsSync(objectsRoot) || !statSync(objectsRoot).isDirectory()) fail(`对象目录不存在：${objectsRoot}`, 2)
if (existsSync(outRoot)) fail(`备份目录已存在，拒绝覆盖：${outRoot}`, 2)

const startedAt = Date.now()
// 1) Quiesce guard: an EXCLUSIVE lock proves no concurrent writer at this moment.
//    The operator still must stop the application first; this is a safety net.
//    The output directory is only created after the guard passes so a failed
//    quiesced check does not leave a half-usable backup directory behind.
const control = new DatabaseSync(databasePath)
try {
  control.exec("PRAGMA busy_timeout=1000")
  try {
    control.exec("BEGIN EXCLUSIVE")
    control.exec("COMMIT")
  } catch (error) {
    fail(`数据库仍有写入（${error.message}）；必须先停止应用并确认写入静止后重试（quiesced 备份要求）`, 2)
  }
} finally {
  control.close()
}
mkdirSync(outRoot, { recursive: true, mode: 0o700 })

// 2) Consistent database snapshot (VACUUM INTO is a read-snapshot copy).
const databaseCopy = join(outRoot, "database.sqlite")
const vacuum = new DatabaseSync(databasePath)
try {
  vacuum.exec(`VACUUM INTO '${databaseCopy.replace(/'/g, "''")}'`)
} finally {
  vacuum.close()
}
const databaseSha256 = sha256File(databaseCopy)
const databaseBytes = statSync(databaseCopy).size
const databaseCheck = new DatabaseSync(databaseCopy, { readOnly: true })
let migrationLedger = []
let templateVersions = []
let publicationVersions = []
try {
  const integrity = databaseCheck.prepare("PRAGMA integrity_check").all()
  assert.equal(integrity.length, 1, "integrity_check 返回多行")
  assert.equal(integrity[0]?.integrity_check, "ok", `integrity_check 失败：${JSON.stringify(integrity)}`)
  const tableExists = name => databaseCheck.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(name).length > 0
  if (tableExists("equilens_business_migrations")) {
    migrationLedger = databaseCheck.prepare("SELECT id,checksum FROM equilens_business_migrations ORDER BY id").all()
      .map(row => ({ id: String(row.id), checksum: String(row.checksum) }))
  }
  if (tableExists("equilens_result_exports")) {
    templateVersions = databaseCheck.prepare("SELECT DISTINCT template_version,render_version FROM equilens_result_exports ORDER BY template_version,render_version").all()
      .map(row => ({ templateVersion: String(row.template_version), renderVersion: String(row.render_version) }))
  }
  if (tableExists("equilens_publication_versions") && tableExists("equilens_publications")) {
    publicationVersions = databaseCheck.prepare(
      "SELECT p.kind AS kind,p.artifact_id AS artifact_id,v.version AS version,v.state AS state FROM equilens_publication_versions v JOIN equilens_publications p ON p.id=v.publication_id ORDER BY p.kind,p.artifact_id,v.version",
    ).all().map(row => ({ kind: String(row.kind), artifactId: String(row.artifact_id), version: String(row.version), state: String(row.state) }))
  }
} finally {
  databaseCheck.close()
}

// 3) Object bytes: verify each immutable object against its header SHA-256, then copy.
const objectEntries = []
const objectFiles = []
function walk(root, current = root) {
  for (const name of readdirSync(current)) {
    const path = join(current, name)
    const info = statSync(path)
    if (info.isDirectory()) { walk(root, path); continue }
    if (info.isFile()) objectFiles.push({ path, size: info.size })
  }
}
walk(objectsRoot)
for (const file of objectFiles) {
  const buffer = readFileSync(file.path)
  const newline = buffer.indexOf(0x0a)
  if (newline <= 0 || newline > 2048) fail(`对象缺少合法头：${relative(objectsRoot, file.path)}`)
  let header
  try { header = JSON.parse(buffer.subarray(0, newline).toString("utf8")) } catch { fail(`对象头不是 JSON：${relative(objectsRoot, file.path)}`) }
  const key = String(header?.key ?? "")
  const payload = buffer.subarray(newline + 1)
  if (header?.version !== 1 || !key) fail(`对象头版本或键无效：${relative(objectsRoot, file.path)}`)
  const expectedRelative = key.split("/").join(sep)
  if (relative(objectsRoot, file.path) !== expectedRelative) fail(`对象键与路径不一致：${relative(objectsRoot, file.path)}`)
  const payloadSha = sha256(payload)
  if (payloadSha !== header.sha256) fail(`对象内容摘要与头不一致：${key}`)
  if (payload.byteLength !== header.size) fail(`对象长度与头不一致：${key}`)
  if (objectEntries.some(entry => entry.key === key)) fail(`对象键重复：${key}`)
  const destination = join(outRoot, "objects", ...key.split("/"))
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  copyFileSync(file.path, destination)
  const copied = readFileSync(destination)
  const copiedNewline = copied.indexOf(0x0a)
  if (copiedNewline <= 0 || sha256(copied.subarray(copiedNewline + 1)) !== payloadSha) fail(`对象复制校验失败：${key}`)
  objectEntries.push({ key, sha256: payloadSha, size: payload.byteLength })
}
const referenceCheck = new DatabaseSync(databaseCopy, { readOnly: true })
try { verifyBackupReferences(referenceCheck, objectEntries) } finally { referenceCheck.close() }

// 4) Latest private deletion journal (metadata only; may not exist yet).
const journalEntries = []
let journalPresent = false
if (journalRoot && existsSync(journalRoot) && statSync(journalRoot).isDirectory()) {
  journalPresent = true
  const destinationRoot = join(outRoot, "deletion-journal")
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 })
  for (const name of readdirSync(journalRoot).sort()) {
    const path = join(journalRoot, name)
    if (!statSync(path).isFile()) continue
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) fail(`删除日志文件名不符合 <uuid>.json：${name}`)
    const bytes = readFileSync(path)
    try { JSON.parse(bytes.toString("utf8")) } catch { fail(`删除日志不是合法 JSON：${name}`) }
    copyFileSync(path, join(destinationRoot, name))
    const digest = sha256(bytes)
    if (sha256File(join(destinationRoot, name)) !== digest) fail(`删除日志复制校验失败：${name}`)
    journalEntries.push({ name, sha256: digest })
  }
}

// 5) Non-sensitive configuration name list (names only; no values are copied).
// Commented `# NAME=` sample lines are included as well so the frozen restore-critical
// names (lifecycle/deletion journal, provider, origin) are never omitted just because
// a deployment inherited them from defaults instead of uncommenting the example file.
const environmentFile = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", ".env.example")
const requiredConfigNames = [
  "DATABASE_PROVIDER",
  "SQLITE_PATH",
  "APP_ORIGIN",
  "ANONYMOUS_DATA_RETENTION_DAYS",
  "PROJECT_DELETION_JOURNAL_DIR",
  "PROJECT_RECLAIM_BATCH",
  "PROJECT_LIFECYCLE_INTERVAL_MS",
]
const configNames = new Set(requiredConfigNames)
if (existsSync(environmentFile)) {
  for (const line of readFileSync(environmentFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^#?\s*([A-Z][A-Z0-9_]+)=/)
    if (match) configNames.add(match[1])
  }
}
const configNameList = [...configNames].sort()

// 6) Manifest: the backup set is only complete together with the deletion journal
//    and the object manifest; DB-only backups are explicitly rejected by docs.
const manifest = {
  version: 1,
  kind: "equilens-project-backup-set",
  createdAt: new Date().toISOString(),
  appVersion,
  quiesced: true,
  database: { file: "database.sqlite", sha256: databaseSha256, size: databaseBytes },
  root: {
    database: "database.sqlite",
    objects: "objects",
    journal: journalPresent ? "deletion-journal" : null,
    sourcePaths: { database: databasePath, objects: objectsRoot, journal: journalRoot },
  },
  objects: objectEntries,
  objectCount: objectEntries.length,
  journal: { present: journalPresent, dir: journalPresent ? "deletion-journal" : null, files: journalEntries },
  migrationLedger,
  templates: templateVersions,
  publicationsGlobal: publicationVersions,
  configNames: configNameList,
  keyRecovery: "凭据与密钥不进入备份集：恢复后必须重新注入私有配置（AI_API_KEY/AI_BASE_URL、OCR_*、BOOTSTRAP_ADMIN_* 如需要等），登录会话/cookie 不可恢复；本清单只记录配置名，不记录值。数据库行与对象字节共同构成项目数据，缺一项都不算完整恢复。",
  notes: [
    "Local SQLite + dev file object store backup set; NOT a verified OBS/GaussDB/CI/off-host backup.",
    "Backup must be taken while application writes are stopped (quiesced); the EXCLUSIVE-lock guard only detects writers at the instant of backup.",
    "Copy this directory off-host/off-volume before treating it as a restore source; same-volume copies are not off-host backups.",
    "Restore to a NEW root, verify database sha256/integrity and every object sha256, then replay the latest deletion journal before serving.",
  ],
}
writeFileSync(join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({
  ok: true,
  out: outRoot,
  database: { sha256: databaseSha256, size: databaseBytes },
  objects: objectEntries.length,
  journal: journalEntries.length,
  journalPresent,
  migrations: migrationLedger.length,
  elapsedMs: Date.now() - startedAt,
  note: "complete backup set (database + objects + journal + manifest); local synthetic evidence only",
}, null, 2))
