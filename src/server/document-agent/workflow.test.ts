import assert from "node:assert/strict"
import { test } from "node:test"
import { repairToolInput } from "./workflow"

test("AC-09/23: only JSON syntax glitches are repaired before schema validation", () => {
  assert.equal(repairToolInput('{"gaps": [],, "notes": ["范围提示"]}'), '{"gaps": [], "notes": ["范围提示"]}')
  assert.equal(repairToolInput('{"checks": [{"id": "a", "accepted": true},]}'), '{"checks": [{"id": "a", "accepted": true}]}')
  assert.equal(repairToolInput('{"gaps": [], "notes": [}'), null)
  assert.equal(repairToolInput('{"gaps": []'), null)
})
