import assert from "node:assert/strict"
import { test } from "node:test"
import { createWordSerializer, editorText, serializeWord, WordExportTimeout } from "./serialize"

test("WD-06/08: an engine exception must reject fallback original bytes", async () => {
  let errors = 0
  const original = new Blob(["original"])
  await assert.rejects(serializeWord(async () => { errors++; return original }, () => errors), /导出失败/)
})

test("WD-08: successful serialization returns the exact edited Blob", async () => {
  const edited = new Blob(["edited"])
  assert.equal(await serializeWord(async () => edited, () => 0), edited)
  await assert.rejects(serializeWord(async () => new Blob(), () => 0), /导出失败/)
})

test("WD-06: a stalled export rejects within its deadline", async () => {
  await assert.rejects(serializeWord(() => new Promise(() => {}), () => 0, 5), /超时/)
})

for (const outcome of ["resolve", "reject"] as const) {
  test(`WD-06/07: timed-out ${outcome} keeps the instance locked until the exporter settles`, async () => {
    let resolve!: (value: Blob) => void
    let reject!: (error: Error) => void
    const deferred = new Promise<Blob>((yes, no) => { resolve = yes; reject = no })
    const serialize = createWordSerializer(() => 0, 5)
    let settled = false
    let exports = 0
    const first = serialize(async () => {
      exports++
      try { return await deferred } finally { settled = true }
    })
    await assert.rejects(first, WordExportTimeout)
    assert.equal(settled, false)
    await assert.rejects(serialize(async () => { exports++; return new Blob(["second"]) }), /仍在处理/)
    assert.equal(exports, 1)
    if (outcome === "resolve") resolve(new Blob(["late"]))
    else reject(new Error("late vendor failure"))
    await new Promise((done) => setImmediate(done))
    assert.equal(settled, true)
    assert.equal((await serialize(async () => new Blob(["next"]))).size, 4)
  })
}

test("WD-07: late settlement is confined to its own instance lock", async () => {
  let resolve!: (value: Blob) => void
  const old = createWordSerializer(() => 0, 5)
  const current = createWordSerializer(() => 0, 100)
  await assert.rejects(old(() => new Promise<Blob>((yes) => { resolve = yes })), WordExportTimeout)
  let settleCurrent!: (value: Blob) => void
  const pending = current(() => new Promise<Blob>((yes) => { settleCurrent = yes }))
  resolve(new Blob(["old"]))
  await new Promise((done) => setImmediate(done))
  await assert.rejects(current(async () => new Blob(["overlap"])), /仍在处理/)
  settleCurrent(new Blob(["current"]))
  assert.equal(await (await pending).text(), "current")
})

test("WD-08: edit snapshot text follows nested paragraphs and table cells", () => {
  assert.equal(editorText({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "合同 & 001" }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "四十五日" }] }] }] }] },
    { type: "paragraph", content: [{ type: "hardBreak" }, { type: "text", text: "第二页" }] },
  ] }), "合同 & 001四十五日第二页")
})
