import assert from "node:assert/strict"
import test from "node:test"
import { submitMaterialUpload } from "./project-upload"

function events() {
  const log: string[] = []
  return { log }
}

test("accepted upload refreshes the list before the sheet may close", async () => {
  const { log } = events()
  let busy = false
  const result = await submitMaterialUpload({
    upload: async () => { log.push("upload") },
    refresh: async () => { log.push(`refresh while busy=${busy}`) },
    isCurrent: () => true,
    setBusy: value => { busy = value; log.push(`busy:${value}`) },
    setError: message => { if (message) log.push(`error:${message}`) },
  })
  assert.equal(result, true)
  assert.deepEqual(log, ["busy:true", "upload", "refresh while busy=true", "busy:false"])
})

test("failed upload keeps the form open with a visible error and never refreshes", async () => {
  const { log } = events()
  const result = await submitMaterialUpload({
    upload: async () => { throw new Error("材料处理暂不可用，请稍后重试。") },
    refresh: async () => { log.push("refresh") },
    isCurrent: () => true,
    setBusy: value => log.push(`busy:${value}`),
    setError: message => { if (message) log.push(`error:${message}`) },
  })
  assert.equal(result, false)
  assert.deepEqual(log, ["busy:true", "error:材料处理暂不可用，请稍后重试。", "busy:false"])
})

test("accepted upload still closes when the follow-up list refresh fails", async () => {
  const { log } = events()
  const result = await submitMaterialUpload({
    upload: async () => { log.push("upload") },
    refresh: async () => { throw new Error("网络连接失败，请重试。") },
    isCurrent: () => true,
    setBusy: value => log.push(`busy:${value}`),
    setError: message => { if (message) log.push(`error:${message}`) },
  })
  assert.equal(result, true)
  assert.deepEqual(log, ["busy:true", "upload", "error:网络连接失败，请重试。", "busy:false"])
})

test("a stale workspace never submits and never closes the sheet", async () => {
  const { log } = events()
  const result = await submitMaterialUpload({
    upload: async () => { log.push("upload") },
    refresh: async () => { log.push("refresh") },
    isCurrent: () => false,
    setBusy: value => log.push(`busy:${value}`),
    setError: message => { if (message) log.push(`error:${message}`) },
  })
  assert.equal(result, false)
  assert.deepEqual(log, [])
})

test("acceptance that arrives after the workspace changed does not refresh or close", async () => {
  const { log } = events()
  let current = true
  const result = await submitMaterialUpload({
    upload: async () => { current = false },
    refresh: async () => { log.push("refresh") },
    isCurrent: () => current,
    setBusy: value => log.push(`busy:${value}`),
    setError: message => { if (message) log.push(`error:${message}`) },
  })
  assert.equal(result, false)
  assert.deepEqual(log, ["busy:true"])
})
