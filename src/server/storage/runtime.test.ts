import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

test("private runtime storage requires explicit development opt-in and shares bytes", () => {
  const script = `import { privateObjectStoreRuntime as get } from './src/server/storage/runtime.ts';
    import { exportObjectKey } from './src/server/storage/obs.ts';
    import assert from 'node:assert/strict';
    const key = exportObjectKey({projectId:'11111111-1111-4111-8111-111111111111',exportId:'22222222-2222-4222-8222-222222222222',sha256:'a'.repeat(64)});
    if(process.env.NODE_ENV==='development' && process.env.EQUILENS_SYNTHETIC_STORAGE==='1') {
      assert.equal(get(),get()); await get().put({key,bytes:new Uint8Array([1]),contentType:'text/plain'}); assert.ok(await get().get(key));
    } else { await assert.rejects(get().get(key)); }`
  for (const [mode,flag] of [["production","1"],["test","1"],["development","0"],["development","1"]] as const) {
    execFileSync(process.execPath,["--conditions=react-server","--import","tsx","--input-type=module","-e",script],{ env: { ...process.env,NODE_ENV: mode,EQUILENS_SYNTHETIC_STORAGE: flag } })
  }
  for (const file of ["materials/http-runtime","materials/runtime","materials/access","materials/editor-runtime","exports/access","exports/export-runtime"]) {
    assert.match(readFileSync(`src/server/${file}.ts`,"utf8"),/privateObjectStoreRuntime/)
  }
})
