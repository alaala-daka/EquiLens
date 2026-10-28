import assert from "node:assert/strict"
import { test } from "node:test"
import { downloadRevisedContract, RevisionDownloadError } from "./client"
import { DocumentSessionError, setDocumentContext } from "../documents/client"

const target = "11111111-1111-4111-8111-111111111111"

test("AC-11：任务ID用错返回显式目标，不自动发第二次下载；未生成错误保持独立", async t => {
  setDocumentContext("current-context")
  let calls = 0
  const mock = t.mock.method(globalThis, "fetch", async () => {
    calls++
    return Response.json({ error: "请打开对应修订任务。", code: "REVISION_TASK_REQUIRED", revisionTaskId: target }, { status: 409 })
  })
  await assert.rejects(downloadRevisedContract("source-task"), failure => failure instanceof RevisionDownloadError &&
    failure.code === "REVISION_TASK_REQUIRED" && failure.revisionTaskId === target)
  assert.equal(calls, 1)
  mock.mock.restore()
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "尚未生成。", code: "REVISION_NOT_READY" }, { status: 409 }))
  await assert.rejects(downloadRevisedContract(target), failure => failure instanceof RevisionDownloadError &&
    failure.code === "REVISION_NOT_READY" && failure.revisionTaskId === undefined)
})

test("AC-01/11：会话切换或到期时不提供其他任务的跳转目标", async t => {
  setDocumentContext("old-context")
  const mock = t.mock.method(globalThis, "fetch", async () => {
    setDocumentContext("new-context")
    return Response.json({ code: "REVISION_TASK_REQUIRED", revisionTaskId: target }, { status: 409 })
  })
  await assert.rejects(downloadRevisedContract("source-task"), failure => failure instanceof DocumentSessionError && failure.code === "SESSION_CHANGED")
  mock.mock.restore()
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "资料已到期。", code: "RETENTION_EXPIRED" }, { status: 410 }))
  await assert.rejects(downloadRevisedContract(target), failure => failure instanceof DocumentSessionError && failure.code === "RETENTION_EXPIRED")
})
