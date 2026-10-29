import assert from "node:assert/strict"
import test from "node:test"
import { retainProject, workspaceRoute } from "./project-retention"
import { createUnsavedRegistry } from "../../../lib/documents/unsaved-registry"

test("router keeps retained project mounted after 401 instead of rendering anonymous workspace", () => {
  for (const status of ["ready", "anonymous", "error", "loading"]) {
    assert.equal(workspaceRoute(status, { id: "dirty-project" }), "project")
  }
  assert.equal(workspaceRoute("anonymous", null), "anonymous")
  assert.equal(workspaceRoute("loading", null), "loading")
})

test("focus refresh retains workspace identity on downgrade, removal and network failure", () => {
  const current = { id: "a", role: "editor" }
  const dirtyEngine = { text: "未保存", dirty: true }
  for (const list of [[{ id: "a", role: "viewer" }], [{ id: "b", role: "editor" }], null]) {
    const result = retainProject(current, list)
    assert.equal(result.project?.id, "a")
    assert.equal(result.blocked, !list || list[0].id !== "a")
    const instances = new Map([[current.id, dirtyEngine]])
    assert.equal(instances.get(result.project!.id), dirtyEngine)
  }
  assert.equal(retainProject(current, [current]).blocked, false)
})

test("failed save keeps the current project and dirty registry entry", async () => {
  const registry = createUnsavedRegistry()
  registry.register({ id: "doc", label: "合同", save: async () => false })
  let selected = "a"
  if ((await registry.saveAll()).ok) selected = "b"
  assert.equal(selected, "a")
  assert.equal(registry.hasUnsaved(), true)
})
