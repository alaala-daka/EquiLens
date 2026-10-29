import assert from "node:assert/strict"
import { test } from "node:test"
import { NextRequest } from "next/server"
import type { AuthIdentity } from "../auth/service"
import type { ExportService } from "./service"
import { BusinessError } from "../projects/errors"
import { exportHandler } from "./http"

test("export HTTP bounds input, fixes project, uses private responses and masks failures", async () => {
  const previous = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = "https://example.test"
  try {
    const service = { async list() { return [] },async download() { return new Uint8Array([1,2,3]) },async createExport() { throw new BusinessError("FORBIDDEN","无权操作该导出。") } } as unknown as ExportService
    const services = async () => ({ identity: async () => ({ account: { id: "a" } } as AuthIdentity),authorize: async () => { throw new Error("unused") },service })
    const context = { params: Promise.resolve({ id: "p",resultId: "r",exportId: "e" }) }
    const list = await exportHandler(services,"list")(new NextRequest("https://example.test/api"),context)
    assert.equal(list.status,200); assert.equal(list.headers.get("cache-control"),"private, no-store")
    const content = await exportHandler(services,"download")(new NextRequest("https://example.test/api"),context)
    assert.deepEqual(new Uint8Array(await content.arrayBuffer()),new Uint8Array([1,2,3]))
    for (const [body,status] of [[{ projectId: "other",versionId: "v",sha256: "hash" },400],[{ versionId: "v",sha256: "hash" },403]] as const) {
      const response = await exportHandler(services,"create")(new NextRequest("https://example.test/api",{ method: "POST",headers: { origin: "https://example.test","content-type": "application/json" },body: JSON.stringify(body) }),context)
      assert.equal(response.status,status)
    }
    const oversized = await exportHandler(services,"create")(new NextRequest("https://example.test/api",{ method: "POST",headers: { origin: "https://example.test","content-type": "application/json" },body: "x".repeat(4097) }),context)
    assert.equal(oversized.status,429)
    const unauthenticated = await exportHandler(async () => { throw Object.assign(new Error("secret"),{ code: "UNAUTHENTICATED" }) },"list")(new NextRequest("https://example.test/api"),context)
    assert.ok(!((await unauthenticated.text()).includes("secret")))
  } finally { if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous }
})
