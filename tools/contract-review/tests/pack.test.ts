import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { loadRulePack } from "../src/pack"
import { testPack } from "./helpers"

test("AC-21：正式发布须有核对记录，合成来源不能直接改状态发布", async t => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-review-pack-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pack = testPack()
  const save = async () => {
    await writeFile(join(directory, "pack.json"), JSON.stringify(pack.manifest))
    await writeFile(join(directory, "rules.json"), JSON.stringify(pack.rules))
    await writeFile(join(directory, "sources.json"), JSON.stringify(pack.sources))
  }
  await save()
  assert.equal((await loadRulePack(directory)).manifest.status, "已发布")
  pack.sources[0].illustrative = true
  await save()
  await assert.rejects(loadRulePack(directory))
  pack.sources[0].illustrative = false
  pack.sources[0].reviewedAt = null
  await save()
  await assert.rejects(loadRulePack(directory))
})

test("AC-24：规则清单不能读取包目录以外文件", async t => {
  const directory = await mkdtemp(join(tmpdir(), "equilens-review-pack-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pack = testPack()
  pack.manifest.ruleFiles = ["../outside.json"]
  await writeFile(join(directory, "pack.json"), JSON.stringify(pack.manifest))
  await assert.rejects(loadRulePack(directory), /规则文件必须位于规则包目录内/)
})
