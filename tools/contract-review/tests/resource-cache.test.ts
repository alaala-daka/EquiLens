import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { ContentHashCache, type ResourceTextReader } from "../src/resource-cache"
import { loadRulePack, readRulePackSnapshot } from "../src/pack"
import { loadReviewSkill, readReviewSkillSnapshot, type ReviewSkill } from "../src/agent/skill"
import { loadSceneBundles, type SceneBundle } from "../src/bundles"
import { scenes } from "../src/scenes"
import type { LoadedPack } from "../src/types"
import { testPack } from "./helpers"

test("AC-23: content cache returns isolated copies, bounds entries with LRU, and never caches failed builds", () => {
  const cache = new ContentHashCache<{ values: string[] }>(2)
  let builds = 0
  const build = () => { builds++; return { values: ["fixed"] } }
  const first = cache.getOrCreate("a", build); first.values.push("caller edit")
  assert.deepEqual(cache.getOrCreate("a", build).values, ["fixed"])
  assert.equal(builds, 1); assert.equal(cache.hits, 1)
  cache.getOrCreate("b", build); cache.getOrCreate("a", build); cache.getOrCreate("c", build)
  assert.equal(cache.size, 2)
  cache.getOrCreate("b", build)
  assert.equal(builds, 4, "least recently used b was evicted")
  assert.throws(() => cache.getOrCreate("invalid", () => { throw new Error("invalid file") }))
  assert.equal(cache.size, 2)
  assert.throws(() => cache.getOrCreate("invalid", () => { throw new Error("still invalid") }))
})

test("AC-21/23: pack cache checks current contents despite identical path/mtime, and invalid new content never returns an old pack", async t => {
  const root = await mkdtemp(join(tmpdir(), "equilens-pack-cache-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pack = testPack(), cache = new ContentHashCache<LoadedPack>(4)
  await Promise.all([writeFile(join(root, "pack.json"), JSON.stringify(pack.manifest)), writeFile(join(root, "rules.json"), JSON.stringify(pack.rules)),
    writeFile(join(root, "sources.json"), JSON.stringify(pack.sources))])
  const sourcePath = join(root, "sources.json"), fixedTime = new Date("2026-10-01T00:00:00Z")
  await utimes(sourcePath, fixedTime, fixedTime)
  const originalStat = await stat(sourcePath)
  const firstSnapshot = await readRulePackSnapshot(root, { cache })
  const first = firstSnapshot.load(); first.rules[0].requirement = "caller edit"
  assert.notEqual((await loadRulePack(root, { cache })).rules[0].requirement, "caller edit")
  assert.equal(cache.hits, 1)
  pack.sources[0].text = "合成来源原文已发生变更。"
  await writeFile(sourcePath, JSON.stringify(pack.sources)); await utimes(sourcePath, originalStat.atime, originalStat.mtime)
  const secondSnapshot = await readRulePackSnapshot(root, { cache })
  assert.notEqual(firstSnapshot.sha256, secondSnapshot.sha256)
  assert.equal(Math.trunc((await stat(sourcePath)).mtimeMs), Math.trunc(originalStat.mtimeMs))
  assert.equal(secondSnapshot.load().sources[0].text, pack.sources[0].text)
  assert.equal(cache.misses, 2)
  await writeFile(sourcePath, "not JSON"); await utimes(sourcePath, originalStat.atime, originalStat.mtime)
  await assert.rejects(loadRulePack(root, { cache }), /不是合法 JSON/)
  await rm(sourcePath)
  await assert.rejects(loadRulePack(root, { cache }), /读取规则文件失败/)
})

test("AC-21/23: skill content changes its digest with stable mtime, and snapshot parsing never rereads a changed file", async t => {
  const root = await mkdtemp(join(tmpdir(), "equilens-skill-cache-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, "contract-review"); await mkdir(directory)
  const info = { id: "contract-review", name: "合成技能", version: "1", description: "缓存测试" }
  await writeFile(join(directory, "skill.json"), JSON.stringify(info))
  const skillPath = join(directory, "SKILL.md"); await writeFile(skillPath, "合成技能第一版。")
  const fixedTime = new Date("2026-10-01T00:00:00Z"); await utimes(skillPath, fixedTime, fixedTime)
  const originalStat = await stat(skillPath), cache = new ContentHashCache<ReviewSkill>(4)
  const original = await loadReviewSkill(root, "contract-review", { cache }); original.instructions = "caller edit"
  assert.equal((await loadReviewSkill(root, "contract-review", { cache })).instructions, "合成技能第一版。")
  assert.equal(cache.hits, 1)
  await writeFile(skillPath, "合成技能第二版。"); await utimes(skillPath, originalStat.atime, originalStat.mtime)
  const changed = await loadReviewSkill(root, "contract-review", { cache })
  assert.notEqual(changed.sha256, original.sha256)
  assert.equal(Math.trunc((await stat(skillPath)).mtimeMs), Math.trunc(originalStat.mtimeMs))
  const reads = new Map<string, number>()
  const reader: ResourceTextReader = async path => {
    reads.set(path, (reads.get(path) ?? 0) + 1)
    return path.endsWith("skill.json") ? JSON.stringify(info) : "固定读取的技能原文。"
  }
  const snapshot = await readReviewSkillSnapshot(root, "contract-review", { readText: reader, cache })
  assert.equal(snapshot.load().instructions, "固定读取的技能原文。")
  assert.equal(snapshot.load().instructions, "固定读取的技能原文。")
  assert.ok([...reads.values()].every(count => count === 1))
  await writeFile(skillPath, "")
  await assert.rejects(loadReviewSkill(root, "contract-review", { cache }), { code: "REVIEW_SKILL_INVALID" })
})

test("AC-21/23: bundles reuse raw-content keys, remain isolated, and invalidate for source, skill or catalog changes", async t => {
  const cache = new ContentHashCache<SceneBundle[]>(4), overrides = new Map<string, string>()
  const reader: ResourceTextReader = async path => overrides.get(path) ?? readFile(path, "utf8")
  const first = await loadSceneBundles(process.cwd(), { cache, readText: reader })
  const originalHash = first[0].sha256
  first[0].pack.sources[0].name = "caller edit"; first[0].candidate.exclusions.push("caller edit")
  const second = await loadSceneBundles(process.cwd(), { cache, readText: reader })
  assert.equal(cache.hits, 1)
  assert.equal(second[0].sha256, originalHash)
  assert.notEqual(second[0].pack.sources[0].name, "caller edit")
  assert.ok(!second[0].candidate.exclusions.includes("caller edit"))
  const manifest = JSON.parse(await readFile(resolve("tools/contract-review/rules/pack.json"), "utf8"))
  const sourcePath = resolve("tools/contract-review/rules", manifest.sourceFiles[0])
  const sources = JSON.parse(await readFile(sourcePath, "utf8")); sources[0].text += "\n合成缓存变更测试。"
  overrides.set(sourcePath, JSON.stringify(sources))
  const sourceChanged = await loadSceneBundles(process.cwd(), { cache, readText: reader })
  assert.notEqual(sourceChanged[0].sha256, originalHash)
  const skillPath = resolve("tools/contract-review/skills/contract-review/SKILL.md")
  overrides.set(skillPath, (await readFile(skillPath, "utf8")) + "\n合成缓存测试。")
  const skillChanged = await loadSceneBundles(process.cwd(), { cache, readText: reader })
  assert.notEqual(skillChanged[0].sha256, sourceChanged[0].sha256)
  const oldDescription = scenes["mep-sub-2026"].description
  t.after(() => { scenes["mep-sub-2026"].description = oldDescription })
  scenes["mep-sub-2026"].description += " 合成目录变更。"
  const catalogChanged = await loadSceneBundles(process.cwd(), { cache, readText: reader })
  assert.notEqual(catalogChanged[0].sha256, skillChanged[0].sha256)
  overrides.set(sourcePath, "invalid JSON")
  await assert.rejects(loadSceneBundles(process.cwd(), { cache, readText: reader }), /不是合法 JSON/)
  assert.equal(cache.size, 4)
})

test("AC-21/23: rule pack snapshot parses the same one-read file contents, even if later reader calls would change", async () => {
  const pack = testPack(), counts = new Map<string, number>()
  const resources = new Map([["pack.json", JSON.stringify(pack.manifest)], ["rules.json", JSON.stringify(pack.rules)], ["sources.json", JSON.stringify(pack.sources)]])
  const reader: ResourceTextReader = async path => {
    counts.set(path, (counts.get(path) ?? 0) + 1)
    assert.equal(counts.get(path), 1, "each snapshot file is read once")
    return resources.get(path.split(/[\\/]/).at(-1)!)!
  }
  const snapshot = await readRulePackSnapshot("synthetic-pack", { readText: reader, cache: new ContentHashCache<LoadedPack>(2) })
  assert.equal(snapshot.load().rules.length, pack.rules.length)
  assert.equal(snapshot.load().sources[0].text, pack.sources[0].text)
  assert.equal(counts.size, 3)
})
