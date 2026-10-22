import assert from "node:assert/strict";

const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:3000");

async function get(path) {
  const response = await fetch(new URL(path, baseUrl), {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response;
}

for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const health = await get("/healthz");
    assert.deepEqual(await health.json(), { status: "ok", service: "equilens" });
    assert.equal(health.headers.get("cache-control"), "no-store");
    break;
  } catch (error) {
    if (attempt === 29) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const page = await get("/");
const html = await page.text();
assert.match(html, /<html[^>]*lang="zh-CN"/);
assert.match(html, /<title>衡鉴 EquiLens<\/title>/);
const cssPath = html.match(/href="([^"]*\/_next\/static\/[^"]+\.css[^"]*)"/)?.[1];
assert.ok(cssPath, "The page must reference its bundled stylesheet");
assert.match((await get(cssPath)).headers.get("content-type") ?? "", /text\/css/);
assert.match((await get("/brand.svg")).headers.get("content-type") ?? "", /image\/svg/);
console.log("Smoke checks passed: health, page, stylesheet, public asset.");
