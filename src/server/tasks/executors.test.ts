import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"

test("separate bundles share registered executor identity without starting work", () => {
  const source = readFileSync("src/server/tasks/executors.ts","utf8")
  const code = ts.transpileModule(source,{ compilerOptions: { module: ts.ModuleKind.CommonJS,target: ts.ScriptTarget.ES2022 } }).outputText
  const shared = {}
  const load = () => {
    const exports: Record<string, unknown> = {}
    runInNewContext(code,{ exports,globalThis: shared,Map })
    return exports as { registerTaskExecutor(kind: string,executor: () => void): void; taskExecutorRegistry: { get(kind: string): unknown; available(): string[] } }
  }
  const instrumentation = load(), route = load()
  assert.deepEqual(Array.from(route.taskExecutorRegistry.available()),[])
  let called = false
  const executor = () => { called = true }
  instrumentation.registerTaskExecutor("material-parse",executor)
  assert.equal(route.taskExecutorRegistry.get("material-parse"),executor)
  assert.deepEqual(Array.from(route.taskExecutorRegistry.available()),["material-parse"])
  assert.equal(load().taskExecutorRegistry.get("material-parse"),executor)
  assert.equal(route.taskExecutorRegistry.get("result-export"),null)
  assert.equal(called,false)
})
