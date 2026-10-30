import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { connectDatabase } from "../database/connection"
import { migrateBusiness } from "../database/migrations"
import { applyProjectSchema } from "./schema"
import { createProjectDeletionJournal } from "./deletion-journal"
import { ProjectRepository } from "./repository"
import { journalIntentForRecord } from "./reclamation"

test("C7 CLI: read-only replay validates database conflicts without changing any row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-lifecycle-cli-"))
  const path = join(directory, "project.sqlite")
  const database = await connectDatabase({ provider: "sqlite", path })
  try {
    await migrateBusiness(database)
    await applyProjectSchema(database)
    await database.transaction(connection => connection.query("INSERT INTO equilens_auth_accounts(id,username,password_hash,enabled,revision,role) VALUES($1,$2,$3,1,1,'member')", ["test-owner", "test-owner", "unused-synthetic-hash"]))
    const repository = new ProjectRepository(database)
    const project = await repository.create({ name: "合成恢复项目", source: "synthetic", sourceReference: "合成夹具", purpose: "验证", retentionUntil: "2099-12-31" }, "test-owner")
    const { record } = await repository.delete(project.id, "test-owner", "user-delete")
    const journal = createProjectDeletionJournal(join(directory, "journal"))
    await journal.appendIntent(journalIntentForRecord(record))
    const run = (flags: string[] = []) => spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/project-lifecycle.mts"), "replay", "--journal", journal.directory, ...flags], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, DATABASE_PROVIDER: "sqlite", SQLITE_PATH: path, NODE_ENV: "test" },
    })
    const valid = run()
    assert.equal(valid.status, 0, valid.stderr)
    assert.equal((await repository.deletionRecord(project.id))?.state, "requested")
    await database.transaction(connection => connection.query("UPDATE equilens_project_deletions SET requested_by=$1 WHERE project_id=$2", ["different-owner", project.id]))
    const before = await repository.deletionRecord(project.id)
    const conflicting = run()
    assert.equal(conflicting.status, 1, conflicting.stdout)
    assert.deepEqual(await repository.deletionRecord(project.id), before)
    assert.equal((await repository.findAny(project.id))?.status, "deleted")
    // Only explicit offline application may recover a claim left by a dead process.
    await database.transaction(connection => connection.query("UPDATE equilens_project_deletions SET requested_by=$1,state='reclaiming' WHERE project_id=$2", ["test-owner", project.id]))
    const preview = run()
    assert.equal(preview.status, 0, preview.stderr)
    assert.equal((await repository.deletionRecord(project.id))?.state, "reclaiming")
    const applied = run(["--apply", "--offline-restored-database"])
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal((await repository.deletionRecord(project.id))?.state, "reclaimed")
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})
