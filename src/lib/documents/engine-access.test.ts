import assert from "node:assert/strict"
import test from "node:test"
import { revokeEngineEditing } from "./engine-access"

test("revocation disables editing without replacing unsaved engine content", () => {
  const document = { text: "尚未保存的人工修订", prompt: "核对备注", dirty: true }
  let editable = true
  let mode = "editing"
  const engine = {
    document,
    setDocumentMode(value: string) { mode = value },
    activeEditor: { setEditable(value: boolean, emitUpdate: boolean) { editable = value; assert.equal(emitUpdate, false) } },
  }
  revokeEngineEditing(engine)
  assert.equal(mode, "viewing")
  assert.equal(editable, false)
  assert.equal(engine.document, document)
  assert.deepEqual(document, { text: "尚未保存的人工修订", prompt: "核对备注", dirty: true })
})
