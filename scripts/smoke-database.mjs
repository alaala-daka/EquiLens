import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const origin = new URL(process.argv[2] || "http://127.0.0.1:3000").origin;
const checkpoint = process.argv[3];
const verifyOnly = process.argv.includes("--verify");
let cookie = "";
async function request(path = "", method = "GET", value, authorized = true, withOrigin = true) {
  const response = await fetch(`${origin}/api/documents${path}`, {
    method, headers: { ...(authorized && cookie ? { Cookie: cookie } : {}), ...(withOrigin ? { Origin: origin } : {}), ...(value ? { "Content-Type": "application/json" } : {}) },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  if (authorized && response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  return { status: response.status, value: await response.json() };
}

if (verifyOnly) {
  assert.ok(checkpoint, "Verification needs a checkpoint path");
  const saved = JSON.parse(readFileSync(checkpoint, "utf8"));
  assert.equal(saved.origin, origin);
  cookie = saved.cookie;
  const result = await request(`/${saved.id}`);
  assert.equal(result.status, 200);
  assert.equal(result.value.revision.id, saved.revision);
  assert.equal(result.value.revision.hash, saved.hash);
  assert.equal(createHash("sha256").update(Buffer.from(result.value.revision.blob, "base64")).digest("hex"), saved.hash);
  assert.equal(result.value.document.title, "持久化验证");
  console.log("Database restart persistence passed");
} else {
  assert.equal((await request()).status, 200);
  assert.ok(cookie);
  const blob = readFileSync(new URL("./fixtures/blank-docx.base64", import.meta.url), "utf8").trim();
  const created = await request("", "POST", { title: "合成验证文档", source: "imported", fileName: "synthetic.docx", prompt: "", blob });
  assert.equal(created.status, 201);
  const id = created.value.document.id;
  const save = { title: "持久化验证", prompt: "合成验证输入", blob, baseRevision: created.value.revision.id, operationId: randomUUID() };
  const saved = await request(`/${id}`, "PUT", save);
  assert.equal(saved.status, 200);
  assert.equal(saved.value.revision.blob, blob);
  assert.equal((await request(`/${id}`, "PUT", save)).value.revision.id, saved.value.revision.id);
  assert.equal((await request(`/${id}`, "PUT", { ...save, operationId: randomUUID() })).status, 409);
  assert.equal((await request(`/${id}`, "GET", undefined, false)).status, 404);
  assert.equal((await request("", "GET", undefined, false)).value.length, 0);
  assert.equal((await request("", "POST", { title: "跨会话复制", source: "copy", prompt: "", blob, copiedFrom: { documentId: id, revisionId: saved.value.revision.id } }, false)).status, 404);
  assert.equal((await request(`/${id}`, "PUT", save, true, false)).status, 403);
  assert.equal((await request("", "POST", { title: "无效文件", source: "imported", prompt: "", blob: "aW52YWxpZA==" })).status, 422);
  assert.equal((await request(`/${id}`)).value.revision.id, saved.value.revision.id);
  if (checkpoint) writeFileSync(checkpoint, JSON.stringify({ origin, cookie, id, revision: saved.value.revision.id, hash: saved.value.revision.hash }), { mode: 0o600 });
  console.log("Database API persistence, conflict, ownership, origin and invalid-file checks passed");
}
