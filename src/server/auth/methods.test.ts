import assert from "node:assert/strict"
import test from "node:test"
import { createAuthMethodPolicy } from "./methods"

test("unsupported methods and OPTIONS are private and never invoke authentication", async () => {
  for (const allowed of ["POST", "GET"] as const) {
    let calls = 0
    const policy = createAuthMethodPolicy(allowed, async () => { calls++; return new Response("session", { headers: { "Cache-Control": "private, no-store" } }) })
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      if (method === allowed) continue
      const result = await policy[method](new Request("https://example.test/api/auth", { method }))
      assert.equal(result.headers.get("Cache-Control"), "private, no-store")
      assert.equal(result.status, method === "OPTIONS" ? 204 : method === "HEAD" && allowed === "GET" ? 200 : 405)
      if (method === "OPTIONS") assert.equal(result.headers.get("Allow"), allowed === "GET" ? "GET, HEAD, OPTIONS" : "OPTIONS, POST")
      assert.equal(await result.text(), "")
    }
    assert.equal(calls, allowed === "GET" ? 1 : 0)
  }
})
