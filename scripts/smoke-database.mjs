import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const origin = new URL(process.argv[2] || "http://127.0.0.1:3000").origin;
const checkpoint = process.argv[3];
const verifyOnly = process.argv.includes("--verify");
const digest = blob => createHash("sha256").update(Buffer.from(blob, "base64")).digest("hex");

async function request(identity, path, method = "GET", value, options = {}) {
  const response = await fetch(`${origin}/api/${path}`, {
    method,
    headers: {
      ...(identity?.cookie && !options.withoutCookie ? { Cookie: identity.cookie } : {}),
      ...(identity?.contextId && !options.withoutContext ? { "X-Document-Context": identity.contextId } : {}),
      ...(options.withoutOrigin ? {} : { Origin: options.foreignOrigin ? "https://other.invalid" : origin }),
      ...(value ? { "Content-Type": "application/json" } : {}),
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  assert.match(response.headers.get("cache-control") ?? "", /private.*no-store/);
  if (identity && !options.withoutCookie && response.headers.has("set-cookie")) {
    identity.cookie = response.headers.get("set-cookie").split(";")[0];
  }
  if (path.startsWith("documents") && response.ok) {
    assert.equal(response.headers.get("X-Document-Context"), identity.contextId);
  }
  return { status: response.status, value: await response.json() };
}

async function initialize() {
  const identity = {};
  const result = await request(identity, "document-session");
  assert.equal(result.status, 200);
  assert.ok(identity.cookie, "Session initialization must issue a cookie");
  assert.ok(result.value.contextId);
  assert.equal(result.value.canCreate, true, "Synthetic smoke needs an explicitly registered retention duration");
  assert.ok(result.value.confirmation);
  identity.contextId = result.value.contextId;
  identity.confirmation = result.value.confirmation;
  return identity;
}

if (verifyOnly) {
  assert.ok(checkpoint && checkpoint !== "--verify", "Verification needs a private checkpoint path");
  const saved = JSON.parse(readFileSync(checkpoint, "utf8"));
  assert.equal(saved.origin, origin);
  assert.ok(saved.cookie);
  assert.ok(saved.contextId, "Checkpoint must preserve the document context across restart");
  const identity = { cookie: saved.cookie, contextId: saved.contextId };
  const session = await request(identity, "document-session");
  assert.equal(session.status, 200);
  assert.equal(session.value.contextId, saved.contextId);
  assert.equal(session.value.expiresAt, saved.expiresAt);
  const result = await request(identity, `documents/${saved.id}`);
  assert.equal(result.status, 200);
  assert.equal(result.value.revision.id, saved.revision);
  assert.equal(result.value.revision.hash, saved.hash);
  assert.equal(digest(result.value.revision.blob), saved.hash);
  assert.equal(result.value.document.originalRevision, saved.originalRevision);
  assert.equal(result.value.document.title, "持久化验证");
  console.log("Database restart persistence and fixed session context passed");
} else {
  const a = await initialize();
  const b = await initialize();
  assert.ok(a.cookie !== b.cookie, "Sessions must have distinct credentials");
  assert.notEqual(a.contextId, b.contextId);
  const aList = await request(a, "documents");
  const bList = await request(b, "documents");
  assert.equal(aList.status, 200);
  assert.equal(bList.status, 200);
  assert.deepEqual(aList.value, []);
  assert.deepEqual(bList.value, []);
  const blob = readFileSync(new URL("./fixtures/blank-docx.base64", import.meta.url), "utf8").trim();
  const input = { title: "合成验证文档", source: "imported", fileName: "synthetic.docx", prompt: "", blob };
  const unconfirmed = await request(a, "documents", "POST", input);
  assert.equal(unconfirmed.status, 422);
  assert.equal(unconfirmed.value.code, "RETENTION_CONSENT_REQUIRED");
  const created = await request(a, "documents", "POST", { ...input, retentionConsent: a.confirmation });
  assert.equal(created.status, 201);
  assert.equal(created.value.revision.blob, blob);
  assert.equal(created.value.revision.hash, digest(blob));
  const id = created.value.document.id;
  const originalRevision = created.value.revision.id;
  const active = await request(a, "document-session");
  assert.equal(active.status, 200);
  const expiresAt = active.value.expiresAt;
  assert.ok(expiresAt);
  const save = { title: "持久化验证", prompt: "合成验证输入", blob, baseRevision: originalRevision, operationId: randomUUID() };
  const saved = await request(a, `documents/${id}`, "PUT", save);
  assert.equal(saved.status, 200);
  assert.equal(saved.value.revision.blob, blob);
  assert.equal(saved.value.revision.hash, digest(blob));
  const repeated = await request(a, `documents/${id}`, "PUT", save);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.value.revision.id, saved.value.revision.id);
  const stale = await request(a, `documents/${id}`, "PUT", { ...save, operationId: randomUUID() });
  assert.equal(stale.status, 409);
  assert.equal(stale.value.code, "REVISION_CONFLICT");
  const competingInputs = ["甲", "乙"].map(prompt => ({
    ...save, prompt, baseRevision: saved.value.revision.id, operationId: randomUUID(),
  }));
  const competing = await Promise.all(competingInputs.map(input => request(a, `documents/${id}`, "PUT", input)));
  assert.equal(competing.filter(result => result.status === 200).length, 1);
  // The resource-limited validator can reject overlapping uploads as busy. Retry once,
  // after the winner completed, preserving the losing operation and base revision.
  for (let index = 0; index < competing.length; index++) {
    if (competing[index].status === 429) competing[index] = await request(a, `documents/${id}`, "PUT", competingInputs[index]);
  }
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
  assert.equal(competing.find(result => result.status === 409).value.code, "REVISION_CONFLICT");
  const winner = competing.find(result => result.status === 200).value;
  assert.equal(winner.document.originalRevision, originalRevision);
  // B has its own valid cookie/context; only resource ownership can reject these requests.
  assert.equal((await request(b, `documents/${id}`)).status, 404);
  assert.equal((await request(b, `documents/${id}`, "PUT", save)).status, 404);
  const isolatedList = await request(b, "documents");
  assert.equal(isolatedList.status, 200);
  assert.deepEqual(isolatedList.value, []);
  assert.equal((await request(b, "documents", "POST", {
    title: "跨会话复制", source: "copy", prompt: "", blob,
    copiedFrom: { documentId: id, revisionId: winner.revision.id },
  })).status, 404);
  assert.equal((await request(a, `documents/${randomUUID()}`)).status, 404);
  const missingContext = await request(a, "documents", "GET", undefined, { withoutContext: true });
  assert.equal(missingContext.status, 400);
  assert.equal(missingContext.value.code, "SESSION_CONTEXT_REQUIRED");
  const missingCookie = await request(a, `documents/${id}`, "GET", undefined, { withoutCookie: true });
  assert.equal(missingCookie.status, 409);
  assert.equal(missingCookie.value.code, "SESSION_CHANGED");
  for (const options of [{ withoutOrigin: true }, { foreignOrigin: true }]) {
    assert.equal((await request(a, `documents/${id}`, "PUT", save, options)).status, 403);
    assert.equal((await request(a, "documents", "POST", { ...input, retentionConsent: active.value.confirmation }, options)).status, 403);
  }
  assert.equal((await request(a, "documents", "POST", {
    ...input, title: "无效文件", blob: "aW52YWxpZA==", retentionConsent: active.value.confirmation,
  })).status, 422);
  const opened = await request(a, `documents/${id}`);
  assert.equal(opened.status, 200);
  assert.equal(opened.value.revision.id, winner.revision.id);
  assert.equal(digest(opened.value.revision.blob), winner.revision.hash);
  assert.equal(opened.value.document.originalRevision, originalRevision);
  const finalSession = await request(a, "document-session");
  assert.equal(finalSession.status, 200);
  assert.equal(finalSession.value.expiresAt, expiresAt);
  if (checkpoint) writeFileSync(checkpoint, JSON.stringify({
    origin, cookie: a.cookie, contextId: a.contextId, expiresAt, id, originalRevision,
    revision: winner.revision.id, hash: winner.revision.hash,
  }), { mode: 0o600, flag: "wx" });
  console.log("Database consent, persistence, competition, ownership, origin and invalid-file checks passed");
}
