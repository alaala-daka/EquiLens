import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { DocumentSessionError, RevisionConflict, type createDocument, type saveDocument } from "./client"
import { blankDocx } from "./docx"
import { createEditorSession, type EditorDependencies, type EditorPhase } from "./editor-session"
import type { OpenDocument } from "./types"
import type { AnonymousSessionView, DocumentSessionCode } from "./session-types"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function fixture(overrides: Partial<EditorDependencies> = {}) {
  const blob = blankDocx()
  const documentId = "b1a11947-5a33-4c85-a395-11ba73776eb1"
  const revisionId = "bf3bd91a-97d4-4a35-bf58-06d19fca9551"
  const at = "2026-10-23T02:00:00.000Z"
  const opened: OpenDocument = {
    document: { id: documentId, title: "合成合同", prompt: "", source: "authored", createdAt: at, updatedAt: at, currentRevision: revisionId },
    revision: { id: revisionId, documentId, parentId: null, blob,
      hash: createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex"),
      createdAt: at, editorVersion: "superdoc@1.47.2", templateVersion: null },
  }
  const calls = {
    serialize: 0,
    preflight: [] as { signal: AbortSignal; copy: boolean }[],
    save: [] as { input: Parameters<typeof saveDocument>[0]; options: Parameters<typeof saveDocument>[1] }[],
    copy: [] as Parameters<typeof createDocument>[],
    download: [] as { blob: Blob; title: string }[],
    saved: [] as OpenDocument[],
    unavailable: [] as DocumentSessionError[],
  }
  const saveResult = (input: Parameters<typeof saveDocument>[0]): OpenDocument => ({
    document: { ...opened.document, title: input.title, prompt: input.prompt, currentRevision: input.operationId },
    revision: { ...opened.revision, id: input.operationId, parentId: input.baseRevision, blob: input.blob },
  })
  const copyResult: OpenDocument = {
    document: { ...opened.document, id: "08f5ca65-e668-4116-aa16-af2a0552beec", source: "copy" },
    revision: { ...opened.revision, documentId: "08f5ca65-e668-4116-aa16-af2a0552beec" },
  }
  const deps: EditorDependencies = {
    opened,
    serialize: async () => { calls.serialize++; return overrides.serialize ? overrides.serialize() : blob },
    preflight: async options => { calls.preflight.push(options); await overrides.preflight?.(options) },
    save: async (input, options) => { calls.save.push({ input, options }); return overrides.save ? overrides.save(input, options) : saveResult(input) },
    copy: async (...args) => { calls.copy.push(args); return overrides.copy ? overrides.copy(...args) : copyResult },
    download: (bytes, title) => { calls.download.push({ blob: bytes, title }); overrides.download?.(bytes, title) },
    onSaved: saved => { calls.saved.push(saved); overrides.onSaved?.(saved) },
    onSessionUnavailable: error => { calls.unavailable.push(error); overrides.onSessionUnavailable?.(error) },
  }
  const session = createEditorSession(deps)
  return { session, calls, opened, blob, saveResult, copyResult }
}

test("UI-08/11: clean save is a no-op and export uses the saved Blob", async () => {
  const { session, calls } = await fixture()
  try {
    session.activate()
    session.setEngine("ready")
    await session.run("save")
    assert.equal(calls.save.length, 0)
    assert.equal(calls.preflight.length, 0)
    assert.equal(calls.serialize, 0)
    session.editPrompt("核对付款条款")
    await session.run("save")
    assert.equal(calls.save.length, 1)
    assert.equal(calls.save[0].input.prompt, "核对付款条款")
    assert.equal(session.getSnapshot().dirty, false)
    await session.run("export")
    assert.strictEqual(calls.download[0].blob, session.getSnapshot().saved.revision.blob)
    assert.equal(calls.serialize, 1)
    assert.equal(calls.copy.length, 0)
    assert.equal(calls.saved.length, 1)
  } finally { session.dispose() }
})

test("UI-08/11: dirty export locks inputs and downloads the returned saved bytes", async () => {
  const pending = deferred<OpenDocument>()
  const entered = deferred<void>()
  const { session, calls, opened, saveResult } = await fixture({ save: async () => { entered.resolve(); return pending.promise } })
  const phases: EditorPhase[] = []
  session.subscribe(() => { phases.push(session.getSnapshot().phase) })
  session.activate()
  session.setEngine("ready")
  session.editTitle("  新标题  ")
  session.editPrompt("已编辑输入")
  session.markBodyChanged()
  const operation = session.run("export")
  await entered.promise
  session.editTitle("不得更改")
  session.editPrompt("不得更改")
  session.markBodyChanged()
  assert.equal(session.getSnapshot().title, "  新标题  ")
  assert.equal(session.getSnapshot().prompt, "已编辑输入")
  assert.strictEqual(session.getSnapshot().saved, opened)
  assert.equal(await session.run("save"), null)
  const returned = saveResult({ ...calls.save[0].input, blob: blankDocx() })
  pending.resolve(returned)
  assert.strictEqual(await operation, returned)
  assert.deepEqual(calls.download, [{ blob: returned.revision.blob, title: "新标题" }])
  assert.equal(calls.serialize, 1)
  assert.equal(calls.save.length, 1)
  assert.equal(calls.copy.length, 0)
  assert.equal(session.getSnapshot().title, "新标题")
  assert.equal(session.getSnapshot().dirty, false)
  assert.deepEqual(phases.filter((phase, index) => phase !== phases[index - 1]), ["idle", "checking", "serializing", "saving", "exporting", "idle"])
  session.dispose()
})

test("UI-13: inactive, loading and failed sessions reject dependent operations", async () => {
  const { session, calls } = await fixture()
  for (const intent of ["save", "export", "copy", "reload"] as const) assert.equal(await session.run(intent), null)
  session.activate()
  for (const engine of ["loading", "failed"] as const) {
    session.setEngine(engine, "引擎失败")
    for (const intent of ["save", "export", "copy"] as const) assert.equal(await session.run(intent), null)
  }
  assert.equal(calls.preflight.length, 0)
  assert.equal(calls.serialize, 0)
  assert.equal(calls.save.length, 0)
  assert.equal(calls.copy.length, 0)
  assert.equal(calls.download.length, 0)
  session.dispose()
})

test("DB-02/UI-09: ambiguous save retries exactly the same serialized operation", async () => {
  const committed = new Map<string, OpenDocument>()
  const { session, calls, opened, saveResult } = await fixture({ save: async input => {
    const existing = committed.get(input.operationId)
    if (existing) return existing
    committed.set(input.operationId, resultFor(input))
    throw new Error("响应丢失")
  } })
  const resultFor = saveResult
  session.activate()
  session.setEngine("ready")
  session.editTitle("修改标题")
  session.editPrompt("核对款项")
  assert.equal(await session.run("save"), null)
  assert.equal(calls.save.length, 1, "no automatic HTTP retry")
  assert.strictEqual(session.getSnapshot().saved, opened)
  assert.equal(session.getSnapshot().dirty, true)
  assert.equal(session.getSnapshot().error, "响应丢失")
  const result = await session.run("export")
  assert.ok(result)
  assert.strictEqual(calls.save[0].input, calls.save[1].input)
  assert.equal(calls.serialize, 1)
  assert.equal(calls.preflight.length, 2)
  assert.equal(committed.size, 1)
  assert.equal(calls.copy.length, 0)
  assert.deepEqual(calls.download, [{ blob: result.revision.blob, title: result.document.title }])
  assert.equal(session.getSnapshot().dirty, false)
  session.dispose()
})

for (const edit of ["title", "prompt", "body"] as const) {
  test(`DB-02: ${edit} edit invalidates an ambiguous save snapshot`, async () => {
    let fail = true
    const { session, calls, saveResult, opened } = await fixture({ save: async input => {
      if (fail) throw new Error("连接中断")
      return resultFor(input)
    } })
    const resultFor = saveResult
    session.activate()
    session.setEngine("ready")
    session.markBodyChanged()
    await session.run("save")
    if (edit === "title") session.editTitle("新标题")
    else if (edit === "prompt") session.editPrompt("新输入")
    else session.markBodyChanged()
    fail = false
    await session.run("save")
    assert.equal(calls.serialize, 2)
    assert.equal(calls.save.length, 2)
    assert.notEqual(calls.save[0].input.operationId, calls.save[1].input.operationId)
    assert.equal(calls.save[1].input.baseRevision, opened.revision.id)
    assert.equal(calls.save[1].input.title, edit === "title" ? "新标题" : opened.document.title)
    assert.equal(calls.save[1].input.prompt, edit === "prompt" ? "新输入" : "")
    assert.equal(calls.copy.length, 0)
    assert.equal(calls.download.length, 0)
    session.dispose()
  })
}

test("UI-09: conflict blocks ordinary save/export, reload retains conflict and copy preserves provenance", async () => {
  const { session, calls, opened, copyResult } = await fixture({ save: async () => { throw new RevisionConflict() } })
  session.activate()
  session.setEngine("ready")
  session.editPrompt("保留输入")
  await session.run("save")
  assert.equal(session.getSnapshot().conflict, true)
  assert.equal(session.getSnapshot().dirty, true)
  for (const intent of ["save", "export"] as const) assert.equal(await session.run(intent), null)
  assert.equal(calls.preflight.length, 1)
  assert.equal(calls.serialize, 1)
  session.setEngine("failed", "文档引擎失败")
  assert.strictEqual(await session.run("reload"), opened)
  assert.equal(session.getSnapshot().engine, "loading")
  assert.equal(session.getSnapshot().prompt, "")
  assert.equal(session.getSnapshot().dirty, false)
  assert.equal(session.getSnapshot().conflict, true)
  session.setEngine("ready")
  // Transient engine/error state clears on recovery, but the UI must still
  // derive its persistent copy recovery action from this retained conflict.
  assert.equal(session.getSnapshot().error, null)
  assert.equal(session.getSnapshot().conflict, true)
  session.editPrompt("另存输入")
  const saved = await session.run("copy")
  assert.strictEqual(saved, copyResult)
  assert.equal(calls.serialize, 2)
  assert.equal(calls.save.length, 1)
  assert.equal(calls.copy.length, 1)
  assert.deepEqual(calls.copy[0].slice(0, 6), [opened.revision.blob, "合成合同 副本", "copy", undefined, "另存输入", { documentId: opened.document.id, revisionId: opened.revision.id }])
  assert.strictEqual(calls.copy[0][6]?.signal, calls.preflight[2].signal)
  assert.equal(calls.preflight[2].copy, true)
  assert.equal(calls.download.length, 0)
  assert.equal(session.getSnapshot().conflict, false)
  session.dispose()
})

test("UI-09: ambiguous copy does not retry or claim save idempotency", async () => {
  const { session, calls, opened } = await fixture({ copy: async () => { throw new Error("复制结果未确认") } })
  session.activate()
  session.setEngine("ready")
  session.editPrompt("保存输入")
  assert.equal(await session.run("copy"), null)
  assert.equal(calls.copy.length, 1)
  assert.equal(calls.serialize, 1)
  assert.equal(calls.save.length, 0)
  assert.equal(calls.download.length, 0)
  assert.equal(calls.saved.length, 0)
  assert.strictEqual(session.getSnapshot().saved, opened)
  assert.equal(session.getSnapshot().prompt, "保存输入")
  assert.equal(session.getSnapshot().dirty, true)
  session.dispose()
})

for (const stage of ["preflight", "serialize", "save", "download"] as const) {
  test(`UI-09: ${stage} failure returns idle and protects current inputs and saved bytes`, async () => {
    const fail = () => { throw new Error(`${stage}失败`) }
    const overrides: Partial<EditorDependencies> = stage === "preflight" ? { preflight: fail }
      : stage === "serialize" ? { serialize: fail } : stage === "save" ? { save: fail } : { download: fail }
    const { session, calls, opened } = await fixture(overrides)
    session.activate()
    session.setEngine("ready")
    session.editTitle("待保存标题")
    session.editPrompt("待保存输入")
    assert.equal(await session.run("export"), null)
    assert.equal(session.getSnapshot().phase, "idle")
    assert.equal(session.getSnapshot().error, `${stage}失败`)
    assert.equal(session.getSnapshot().title, "待保存标题")
    assert.equal(session.getSnapshot().prompt, "待保存输入")
    assert.equal(calls.preflight.length, 1)
    assert.equal(calls.serialize, stage === "preflight" ? 0 : 1)
    assert.equal(calls.save.length, ["save", "download"].includes(stage) ? 1 : 0)
    assert.equal(calls.copy.length, 0)
    assert.equal(calls.download.length, stage === "download" ? 1 : 0)
    assert.equal(session.getSnapshot().dirty, stage !== "download")
    if (stage !== "download") assert.strictEqual(session.getSnapshot().saved, opened)
    else assert.strictEqual(session.getSnapshot().saved.revision.blob, calls.save[0].input.blob)
    session.dispose()
  })
}

test("UI-13: reload checks access before clearing failed engine inputs and never writes a revision", async () => {
  let fail = true
  const { session, calls, opened } = await fixture({ preflight: async () => { if (fail) throw new Error("无法核对访问") } })
  session.activate()
  session.editTitle("未保存")
  session.editPrompt("未保存输入")
  session.setEngine("failed", "引擎错误")
  assert.equal(await session.run("reload"), null)
  assert.equal(session.getSnapshot().title, "未保存")
  assert.equal(session.getSnapshot().prompt, "未保存输入")
  assert.equal(session.getSnapshot().dirty, true)
  assert.equal(session.getSnapshot().engine, "failed")
  fail = false
  assert.strictEqual(await session.run("reload"), opened)
  assert.equal(session.getSnapshot().title, opened.document.title)
  assert.equal(session.getSnapshot().prompt, opened.document.prompt)
  assert.equal(session.getSnapshot().engine, "loading")
  assert.equal(session.getSnapshot().dirty, false)
  assert.equal(calls.preflight.length, 2)
  assert.equal(calls.serialize, 0)
  assert.equal(calls.save.length, 0)
  assert.equal(calls.copy.length, 0)
  assert.equal(calls.download.length, 0)
  session.dispose()
})

for (const stage of ["checking", "serializing", "saving"] as const) {
  test(`UI-08/13: ${stage} rejects duplicate intents and locks every input`, async () => {
    const waiting = deferred<void>()
    const entered = deferred<void>()
    const hold = async () => { entered.resolve(); await waiting.promise }
    const { session, calls, blob, saveResult } = await fixture({
      preflight: async () => { if (stage === "checking") await hold() },
      serialize: async () => { if (stage === "serializing") await hold(); return blob },
      save: async input => { if (stage === "saving") await hold(); return resultFor(input) },
    })
    const resultFor = saveResult
    session.activate()
    session.setEngine("ready")
    session.editTitle("锁定标题")
    session.editPrompt("锁定输入")
    const operation = session.run("export")
    await entered.promise
    assert.equal(session.getSnapshot().phase, stage)
    const locked = session.getSnapshot()
    session.editTitle("不应生效")
    session.editPrompt("不应生效")
    session.markBodyChanged()
    assert.strictEqual(session.getSnapshot(), locked)
    for (const intent of ["save", "export", "copy", "reload"] as const) assert.equal(await session.run(intent), null)
    assert.equal(calls.preflight.length, 1)
    assert.equal(calls.copy.length, 0)
    waiting.resolve()
    assert.ok(await operation)
    assert.equal(calls.serialize, 1)
    assert.equal(calls.save.length, 1)
    assert.equal(calls.save[0].input.title, "锁定标题")
    assert.equal(calls.save[0].input.prompt, "锁定输入")
    assert.equal(calls.download.length, 1)
    session.dispose()
  })

  test(`WD-07/UI-13: dispose in ${stage} aborts and fences ignored-abort success after reactivation`, async () => {
    const waiting = deferred<void>()
    const entered = deferred<void>()
    let held = false
    const holdOnce = async () => { if (!held) { held = true; entered.resolve(); await waiting.promise } }
    const { session, calls, blob, opened, saveResult } = await fixture({
      preflight: async () => { if (stage === "checking") await holdOnce() },
      serialize: async () => { if (stage === "serializing") await holdOnce(); return blob },
      save: async input => { if (stage === "saving") await holdOnce(); return resultFor(input) },
    })
    const resultFor = saveResult
    session.activate()
    session.setEngine("ready")
    session.editPrompt("旧代次输入")
    const old = session.run("export")
    await entered.promise
    const oldSignal = calls.preflight[0].signal
    session.dispose()
    assert.equal(oldSignal.aborted, true)
    for (const intent of ["save", "export", "copy", "reload"] as const) assert.equal(await session.run(intent), null)
    assert.strictEqual(session.getSnapshot().saved, opened)
    session.activate()
    session.editPrompt("新代次输入")
    const newer = await session.run("save")
    assert.ok(newer)
    assert.equal(session.getSnapshot().prompt, "新代次输入")
    waiting.resolve()
    assert.equal(await old, null)
    assert.strictEqual(session.getSnapshot().saved, newer)
    assert.equal(session.getSnapshot().dirty, false)
    assert.equal(calls.saved.length, 1)
    assert.equal(calls.download.length, 0)
    assert.equal(calls.copy.length, 0)
    assert.equal(calls.serialize, stage === "checking" ? 1 : 2)
    assert.equal(calls.save.length, stage === "saving" ? 2 : 1)
    assert.equal(session.getSnapshot().phase, "idle")
    session.dispose()
  })
}

test("UI-11/13: exporting is mutually exclusive and dispose prevents download", async () => {
  const { session, calls } = await fixture()
  const duplicates: Promise<OpenDocument | null>[] = []
  session.activate()
  session.setEngine("ready")
  session.subscribe(() => {
    if (session.getSnapshot().phase !== "exporting") return
    for (const intent of ["save", "export", "copy", "reload"] as const) duplicates.push(session.run(intent))
    session.dispose()
  })
  assert.equal(await session.run("export"), null)
  assert.deepEqual(await Promise.all(duplicates), [null, null, null, null])
  assert.equal(calls.preflight.length, 1)
  assert.equal(calls.preflight[0].signal.aborted, true)
  assert.equal(calls.serialize, 0)
  assert.equal(calls.save.length, 0)
  assert.equal(calls.copy.length, 0)
  assert.equal(calls.download.length, 0)
  assert.equal(session.getSnapshot().phase, "idle")
})

for (const intent of ["save", "export", "copy", "reload"] as const) {
  test(`DB-08/UI-13: ${intent} session error is terminal and never becomes a revision conflict`, async () => {
    const failure = new DocumentSessionError("会话已变更", 409, "SESSION_CHANGED")
    const { session, calls, opened } = await fixture({ preflight: async () => { throw failure } })
    session.activate()
    session.setEngine("ready")
    session.editPrompt("未保存输入")
    assert.equal(await session.run(intent), null)
    assert.deepEqual(calls.unavailable, [failure])
    assert.equal(session.getSnapshot().conflict, false)
    assert.equal(session.getSnapshot().dirty, true)
    assert.equal(session.getSnapshot().prompt, "未保存输入")
    assert.strictEqual(session.getSnapshot().saved, opened)
    session.activate()
    for (const next of ["save", "export", "copy", "reload"] as const) assert.equal(await session.run(next), null)
    assert.equal(calls.preflight.length, 1)
    assert.equal(calls.serialize, 0)
    assert.equal(calls.save.length, 0)
    assert.equal(calls.copy.length, 0)
    assert.equal(calls.download.length, 0)
    session.dispose()
  })
}

for (const intent of ["save", "copy"] as const) {
  test(`DB-08: expiration during ${intent} cannot fall back to local export or copy`, async () => {
    const failure = new DocumentSessionError("资料已到期", 410, "RETENTION_EXPIRED")
    const { session, calls } = await fixture({
      save: async () => { throw failure }, copy: async () => { throw failure },
    })
    session.activate()
    session.setEngine("ready")
    session.markBodyChanged()
    assert.equal(await session.run(intent), null)
    assert.deepEqual(calls.unavailable, [failure])
    assert.equal(session.getSnapshot().dirty, true)
    assert.equal(await session.run("export"), null)
    assert.equal(await session.run("copy"), null)
    assert.equal(calls.preflight.length, 1)
    assert.equal(calls.serialize, 1)
    assert.equal(calls.save.length, intent === "save" ? 1 : 0)
    assert.equal(calls.copy.length, intent === "copy" ? 1 : 0)
    assert.equal(calls.download.length, 0)
    session.dispose()
  })
}

test("UI-13: old finally cannot unlock a new generation's pending request", async () => {
  const gates = [deferred<void>(), deferred<void>()]
  const entered = [deferred<void>(), deferred<void>()]
  let index = 0
  const { session, calls } = await fixture({ preflight: async () => {
    const position = index++
    entered[position].resolve()
    await gates[position].promise
  } })
  session.activate()
  session.setEngine("ready")
  session.editPrompt("旧输入")
  const old = session.run("save")
  await entered[0].promise
  session.dispose()
  session.activate()
  session.editPrompt("新输入")
  const current = session.run("save")
  await entered[1].promise
  gates[0].resolve()
  assert.equal(await old, null)
  assert.equal(session.getSnapshot().phase, "checking")
  assert.equal(await session.run("copy"), null)
  gates[1].resolve()
  assert.ok(await current)
  assert.equal(calls.serialize, 1)
  assert.equal(calls.save.length, 1)
  assert.equal(calls.save[0].input.prompt, "新输入")
  assert.equal(calls.copy.length, 0)
  assert.equal(calls.download.length, 0)
  session.dispose()
})

test("UI-08: snapshots remain stable between notifications and unsubscribe releases listeners", async () => {
  const { session, calls } = await fixture()
  let notifications = 0
  const unsubscribe = session.subscribe(() => { notifications++ })
  const initial = session.getSnapshot()
  assert.strictEqual(session.getSnapshot(), initial)
  session.activate()
  session.editTitle(initial.title)
  session.editPrompt(initial.prompt)
  assert.strictEqual(session.getSnapshot(), initial)
  session.markBodyChanged()
  assert.equal(notifications, 1)
  assert.notStrictEqual(session.getSnapshot(), initial)
  unsubscribe()
  session.editPrompt("输入")
  assert.equal(notifications, 1)
  assert.equal(calls.serialize, 0)
  assert.equal(calls.save.length, 0)
  assert.equal(calls.copy.length, 0)
  assert.equal(calls.download.length, 0)
  session.dispose()
})

test("UI-11: failed download retries saved bytes without another save or serialization", async () => {
  let fail = true
  const { session, calls } = await fixture({ download: () => { if (fail) throw new Error("下载失败") } })
  session.activate()
  session.setEngine("ready")
  session.markBodyChanged()
  assert.equal(await session.run("export"), null)
  const saved = session.getSnapshot().saved
  fail = false
  assert.strictEqual(await session.run("export"), saved)
  assert.equal(calls.preflight.length, 2)
  assert.equal(calls.serialize, 1)
  assert.equal(calls.save.length, 1)
  assert.equal(calls.copy.length, 0)
  assert.equal(calls.download.length, 2)
  for (const downloaded of calls.download) assert.strictEqual(downloaded.blob, saved.revision.blob)
  session.dispose()
})

test("UI-09: pending copy submits once and late copy completion cannot replace new input", async () => {
  const pending = deferred<OpenDocument>()
  const entered = deferred<void>()
  const { session, calls, copyResult, opened } = await fixture({ copy: async () => { entered.resolve(); return pending.promise } })
  session.activate()
  session.setEngine("ready")
  session.editPrompt("副本输入")
  const copying = session.run("copy")
  await entered.promise
  for (const intent of ["save", "export", "copy", "reload"] as const) assert.equal(await session.run(intent), null)
  session.dispose()
  session.activate()
  session.editPrompt("新编辑")
  pending.resolve(copyResult)
  assert.equal(await copying, null)
  assert.strictEqual(session.getSnapshot().saved, opened)
  assert.equal(session.getSnapshot().prompt, "新编辑")
  assert.equal(session.getSnapshot().dirty, true)
  assert.equal(calls.preflight.length, 1)
  assert.equal(calls.serialize, 1)
  assert.equal(calls.copy.length, 1)
  assert.equal(calls.save.length, 0)
  assert.equal(calls.download.length, 0)
  assert.equal(calls.saved.length, 0)
  assert.equal(calls.copy[0][6]?.signal?.aborted, true)
  session.dispose()
})

test("WD-07/DB-02: Strict Mode reconnect retries unchanged save with original operation and bytes", async () => {
  const pending = deferred<OpenDocument>()
  const entered = deferred<void>()
  let first = true
  const { session, calls, saveResult } = await fixture({ save: async input => {
    if (first) { first = false; entered.resolve(); return pending.promise }
    return resultFor(input)
  } })
  const resultFor = saveResult
  session.activate()
  session.setEngine("ready")
  session.markBodyChanged()
  const old = session.run("export")
  await entered.promise
  session.dispose()
  session.activate()
  const result = await session.run("save")
  assert.ok(result)
  pending.resolve(result)
  assert.equal(await old, null)
  assert.equal(calls.serialize, 1)
  assert.equal(calls.preflight.length, 2)
  assert.equal(calls.save.length, 2)
  assert.strictEqual(calls.save[0].input, calls.save[1].input)
  assert.equal(calls.copy.length, 0)
  assert.equal(calls.download.length, 0)
  assert.deepEqual(calls.saved, [result])
  assert.strictEqual(session.getSnapshot().saved, result)
  session.dispose()
})

test("DB-08/WD-07: late access failure cannot invalidate a reactivated session", async () => {
  const pending = deferred<void>()
  const entered = deferred<void>()
  const { session, calls } = await fixture({ preflight: async () => { entered.resolve(); return pending.promise } })
  session.activate()
  session.setEngine("ready")
  session.editPrompt("旧输入")
  const old = session.run("export")
  await entered.promise
  session.dispose()
  session.activate()
  session.editPrompt("新输入")
  pending.reject(new DocumentSessionError("旧会话已到期", 410, "RETENTION_EXPIRED"))
  assert.equal(await old, null)
  assert.equal(calls.unavailable.length, 0)
  assert.equal(session.getSnapshot().error, null)
  assert.equal(session.getSnapshot().prompt, "新输入")
  assert.equal(calls.preflight.length, 1)
  assert.equal(calls.serialize, 0)
  assert.equal(calls.save.length, 0)
  assert.equal(calls.copy.length, 0)
  assert.equal(calls.download.length, 0)
  session.dispose()
})

for (const code of ["RETENTION_UNCONFIGURED", "RETENTION_CONSENT_REQUIRED", "RETENTION_CONFIRMATION_CHANGED", "SESSION_RESTART_NOT_ALLOWED"] satisfies DocumentSessionCode[]) {
  test(`DB-08/I1: ${code} copy denial preserves active document save and export permissions`, async () => {
    const view: AnonymousSessionView = {
      contextId: "c0cb9317-e641-4bf0-bc5f-707a9e915d42", state: "active",
      expiresAt: "2026-10-30T02:00:00.000Z", exportUntil: null,
      canRead: true, canSave: true, canCreate: false, canRestart: false, confirmation: null,
      issue: { code, message: "当前操作不可用" },
    }
    const failure = new DocumentSessionError("当前操作不可用", 403, code, view)
    const { session, calls, opened } = await fixture({ preflight: async options => {
      if (options.copy && !view.canCreate) throw failure
      assert.equal(view.canRead, true)
      assert.equal(view.canSave, true)
    } })
    session.activate()
    session.setEngine("ready")
    session.editTitle("待保存合同")
    session.editPrompt("待保存输入")
    assert.equal(await session.run("copy"), null)
    assert.equal(session.getSnapshot().title, "待保存合同")
    assert.equal(session.getSnapshot().prompt, "待保存输入")
    assert.equal(session.getSnapshot().dirty, true)
    assert.strictEqual(session.getSnapshot().saved, opened)
    assert.equal(session.getSnapshot().error, "当前操作不可用")
    assert.equal(calls.serialize, 0)
    assert.equal(calls.copy.length, 0)
    assert.equal(calls.save.length, 0)
    assert.equal(calls.download.length, 0)
    assert.equal(calls.unavailable.length, 0)
    session.editPrompt("继续编辑输入")
    assert.equal(session.getSnapshot().prompt, "继续编辑输入")
    const saved = await session.run("save")
    assert.ok(saved)
    assert.equal(calls.save[0].input.title, "待保存合同")
    assert.equal(calls.save[0].input.prompt, "继续编辑输入")
    assert.strictEqual(await session.run("export"), saved)
    assert.equal(calls.preflight.length, 3)
    assert.deepEqual(calls.preflight.map(options => options.copy), [true, false, false])
    assert.equal(calls.serialize, 1)
    assert.equal(calls.save.length, 1)
    assert.equal(calls.copy.length, 0)
    assert.deepEqual(calls.download, [{ blob: saved.revision.blob, title: saved.document.title }])
    assert.equal(calls.unavailable.length, 0)
    assert.equal(session.getSnapshot().dirty, false)
    session.dispose()
  })
}
