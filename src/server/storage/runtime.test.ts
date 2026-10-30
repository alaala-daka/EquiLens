import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = `import { privateObjectStoreRuntime as get } from './src/server/storage/runtime.ts';
  import { exportObjectKey } from './src/server/storage/obs.ts';
  import assert from 'node:assert/strict';
  const key = exportObjectKey({projectId:'11111111-1111-4111-8111-111111111111',exportId:'22222222-2222-4222-8222-222222222222',sha256:'a'.repeat(64)});
  if(process.env.NODE_ENV==='development' && process.env.EQUILENS_SYNTHETIC_STORAGE==='1') {
    if(process.env.EQUILENS_TEST_WRITE==='1') await get().put({key,bytes:new Uint8Array([1,2,3]),contentType:'text/plain'});
    const value = await get().get(key);
    assert.deepEqual([...(value?.bytes ?? [])], [1,2,3]);
  } else { await assert.rejects(get().get(key)); }`

function run(mode: string, flag: string, environment: Record<string, string | undefined>) {
  execFileSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, NODE_ENV: mode, EQUILENS_SYNTHETIC_STORAGE: flag, ...environment } as NodeJS.ProcessEnv,
  })
}

test("private runtime storage requires explicit development opt-in and persists object bytes across processes", async () => {
  for (const [mode, flag] of [["production", "1"], ["test", "1"], ["development", "0"]] as const) {
    run(mode, flag, { EQUILENS_TEST_WRITE: "1" })
  }
  const root = await mkdtemp(join(tmpdir(), "equilens-runtime-"))
  try {
    run("development", "1", { EQUILENS_TEST_WRITE: "1", EQUILENS_DEV_OBJECT_STORE: root })
    assert.ok((await readdir(root, { recursive: true })).length > 0)
    // A second process simulates the dev-server restart that previously lost in-memory object bytes.
    run("development", "1", { EQUILENS_TEST_WRITE: "0", EQUILENS_DEV_OBJECT_STORE: root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  for (const file of ["materials/http-runtime", "materials/runtime", "materials/access", "materials/editor-runtime", "exports/access", "exports/export-runtime"]) {
    assert.match(readFileSync(`src/server/${file}.ts`, "utf8"), /privateObjectStoreRuntime/)
  }
})
