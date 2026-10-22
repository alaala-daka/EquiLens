import assert from "node:assert/strict"
import { test } from "node:test"
import { NextRequest, NextResponse } from "next/server"
import { failureResponse, inputBody, sameOrigin, session } from "./http"
import { blankDocx } from "../../lib/documents/docx"

test("DB-03: require same-origin writes and issue private HttpOnly session cookies", () => {
  assert.throws(() => sameOrigin(new Request("https://equilens.invalid/api/documents")), { status: 403 })
  assert.throws(() => sameOrigin(new Request("https://equilens.invalid/api/documents", { headers: { Origin: "https://other.invalid" } })), { status: 403 })
  sameOrigin(new Request("https://equilens.invalid/api/documents", { headers: { Origin: "https://equilens.invalid" } }))
  sameOrigin(new Request("http://localhost:3001/api/documents", { headers: { Host: "127.0.0.1:3001", Origin: "http://127.0.0.1:3001" } }))
  const first = session(new NextRequest("https://equilens.invalid/api/documents"))
  const response = first.apply(NextResponse.json([]))
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/i)
  assert.match(response.headers.get("set-cookie")!, /Secure/i)
  assert.match(response.headers.get("set-cookie")!, /SameSite=lax/i)
  const cookie = response.headers.get("set-cookie")!.split(";")[0]
  assert.equal(session(new NextRequest("https://equilens.invalid/api/documents", { headers: { Cookie: cookie } })).owner, first.owner)
  assert.notEqual(session(new NextRequest("https://equilens.invalid/api/documents")).owner, first.owner)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
})

test("DB-04: upload parsing is isolated and rejects invalid files and oversized requests", async () => {
  const body = { title: "合成文件", prompt: "", blob: Buffer.from(await blankDocx().arrayBuffer()).toString("base64") }
  const request = (value: unknown) => new Request("https://equilens.invalid/api/documents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) })
  assert.ok((await inputBody(request(body))).blob.size > 0)
  await assert.rejects(inputBody(request({ ...body, blob: Buffer.from("not a docx").toString("base64") })), { status: 422 })
  await assert.rejects(inputBody(request({ ...body, blob: "INVALID===" })), { status: 400 })
  await assert.rejects(inputBody(new Request("https://equilens.invalid/api/documents", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "99000000" }, body: "{}" })), { status: 413 })
  const response = failureResponse(new Error("sensitive SQL password"))
  assert.equal(response.status, 503)
  assert.doesNotMatch(await response.text(), /password|SQL/)
})
