import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { loadRulePack } from "../src/pack"
import { applicability } from "../src/match"
import { defaultSceneId, isSceneId, sceneIds } from "../src/scenes"
import { rule } from "./helpers"

test("AC-21：适用性由场景标识决定，展示名称变化不影响判定", () => {
  const entry = rule({ appliesTo: { scene: defaultSceneId } })
  assert.equal(applicability(entry, { scene: defaultSceneId, projectType: "改名后的项目类型" }), "applicable")
  assert.equal(applicability(entry, { scene: "other-scene", projectType: "房建机电安装专业分包" }), "excluded")
  // 只给名称、不给场景标识时必须待核实，不能猜成适用。
  assert.equal(applicability(entry, { projectType: "房建机电安装专业分包" }), "unknown")
})

test("AC-21：场景标识只接受已登记取值", () => {
  assert.ok(sceneIds.every(isSceneId))
  assert.ok(!isSceneId("房建机电安装专业分包"))
  assert.ok(!isSceneId(""))
})

test("AC-21：规则包引用未登记场景时拒绝加载，不静默变成永不适用", async () => {
  const root = await mkdtemp(join(tmpdir(), "equilens-scene-"))
  const write = (name: string, value: unknown) => writeFile(join(root, name), JSON.stringify(value, null, 2))
  await mkdir(join(root, "data")).catch(() => {})
  await write("pack.json", {
    version: "synthetic-v1", name: "场景校验测试包", status: "待核对",
    ruleFiles: ["rules.json"], sourceFiles: ["sources.json"],
  })
  await write("sources.json", [
    { sourceId: "S-1", type: "企业审查规则", name: "合成依据", text: "仅用于测试。", status: "待核对" },
  ])
  await write("rules.json", [{
    ruleId: "T-1", category: "付款条件与时间", title: "合成检查", status: "待核对",
    appliesTo: { scene: "not-registered" }, trigger: { keywords: ["付款"] },
    requirement: "合成检查要求。", severity: "提示", basis: [{ sourceId: "S-1" }],
  }])
  await assert.rejects(() => loadRulePack(root), /适用场景未登记/)
})

test("AC-21：内置规则包中每条规则都绑定了已登记场景", async () => {
  const pack = await loadRulePack("tools/contract-review/rules")
  const unknown = pack.rules.filter(item => item.appliesTo.scene && !isSceneId(item.appliesTo.scene))
  assert.deepEqual(unknown.map(item => item.ruleId), [])
  assert.ok(pack.rules.every(item => item.appliesTo.scene === defaultSceneId))
  assert.ok(pack.rules.every(item => item.appliesTo.projectType === undefined))
})
