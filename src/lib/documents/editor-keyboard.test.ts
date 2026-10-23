import assert from "node:assert/strict"
import { test } from "node:test"
import { editorFocusShortcut } from "./editor-keyboard"

const key = { key: "F6", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 117, repeat: false }
const body = { inBody: true, busy: false, popupOpen: false }

test("UI-13: F6 leaves the Word body forwards to Agent and backwards to document actions", () => {
  assert.equal(editorFocusShortcut(key, body), "agent")
  assert.equal(editorFocusShortcut({ ...key, shiftKey: true }, body), "actions")
})

test("UI-13: region switching preserves editing, menu, composition and pending ownership", () => {
  for (const name of ["Tab", "Escape", "ArrowLeft", "s"]) {
    assert.equal(editorFocusShortcut({ ...key, key: name }, body), null)
    assert.equal(editorFocusShortcut({ ...key, key: name, shiftKey: true }, body), null)
  }
  for (const modifier of ["ctrlKey", "metaKey", "altKey", "isComposing", "repeat"] as const) {
    assert.equal(editorFocusShortcut({ ...key, [modifier]: true }, body), null)
  }
  assert.equal(editorFocusShortcut({ ...key, keyCode: 229 }, body), null)
  assert.equal(editorFocusShortcut(key, { ...body, inBody: false }), null)
  assert.equal(editorFocusShortcut(key, { ...body, busy: true }), null)
  assert.equal(editorFocusShortcut(key, { ...body, popupOpen: true }), null)
})
