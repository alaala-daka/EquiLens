import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { defaultSceneId } from "../src/scenes"

test("AC-21: offline handoff example supplies the registered scene and executes every batch", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "tools/contract-review/examples/local.mts"], { encoding: "utf8", timeout: 15000, windowsHide: true })
  const result = JSON.parse(output)
  assert.equal(result.mode, "debug")
  assert.equal(result.model, "synthetic-offline")
  assert.equal(result.input.context.scene, defaultSceneId)
  assert.equal(result.callsUsed, 3)
  assert.deepEqual(result.errors, [])
  assert.equal(result.findings.length, 19)
  assert.ok(result.findings.every((item: { kind: string; risk: string }) => item.kind === "待核实" && item.risk.includes("离线接口示例")))
  assert.equal(result.status, "partial")
})
