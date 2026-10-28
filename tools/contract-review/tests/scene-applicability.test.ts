import assert from "node:assert/strict"
import { test } from "node:test"
import { checkSceneApplicability } from "../src/agent/applicability"
import { reviewWithAgents } from "../src/agent/pipeline"
import { sceneCatalog } from "../src/scenes"
import { loadSceneBundles } from "../src/bundles"

const text = "办公楼机电安装专业分包，总承包人将给排水、电气及通风工程分包给专业分包人。"
const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic" }
function transport(selection: unknown) {
  const menus: string[][] = []
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    menus.push(request.tools.map((item: { function: { name: string } }) => item.function.name))
    if (menus.at(-1)![0] !== "selectScene") return new Response(null, { status: 401 })
    assert.equal(JSON.parse(request.messages.at(-1).content).context.scene, undefined, "manual selection must not bias router")
    return Response.json({ id: "test", object: "chat.completion", created: 1, model: "synthetic", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "route", type: "function", function: { name: "selectScene", arguments: JSON.stringify(selection) } }] } }] })
  }
  return { fetcher, menus }
}
const selection = { status: "matched", sceneId: "mep-sub-2026", reason: "正文明确工程与分包范围。", evidence: [{ paragraphIndex: 0, quote: text }], missingInfo: [] }

test("AC-21: fixed scene and web use independent applicability; mismatched selection never reaches primary", async () => {
  const state = transport(selection)
  const result = await reviewWithAgents({ bundles: await loadSceneBundles(), documentText: text, mode: "debug", env,
    context: { scene: "decoration-sub-2026", role: "专业分包人", region: "上海" }, fetcher: state.fetcher })
  assert.equal(result.sceneSelection?.status, "unsupported")
  assert.equal(result.callsUsed, 1)
  assert.ok(result.errors.some(item => item.code === "REVIEW_SCENE_UNSUPPORTED"))
  assert.deepEqual(state.menus, [["selectScene"]])
  const direct = await checkSceneApplicability({ paragraphs: [{ index: 0, text, inTable: false }], complete: true, candidates: sceneCatalog(), env,
    context: { scene: "decoration-sub-2026", role: "专业分包人" }, fetcher: transport(selection).fetcher })
  assert.equal(direct.selection?.status, "unsupported")
})

test("AC-21: uncertain auto result remains stopped; a fresh applicable selection may enter primary", async () => {
  const bundles = await loadSceneBundles()
  const uncertain = transport({ status: "needs-confirmation", sceneId: null, reason: "范围未确定。", evidence: [{ paragraphIndex: 0, quote: text }], missingInfo: ["专业范围"] })
  const stopped = await reviewWithAgents({ bundles, documentText: text, mode: "debug", env, context: { role: "专业分包人" }, fetcher: uncertain.fetcher })
  assert.equal(stopped.errors[0].code, "REVIEW_SCENE_UNCERTAIN")
  const state = transport(selection)
  const fresh = await reviewWithAgents({ bundles, documentText: text, mode: "debug", env,
    context: { scene: "mep-sub-2026", role: "专业分包人" }, primaryStrategy: "prepared-v1", fetcher: state.fetcher })
  assert.equal(fresh.sceneSelection?.sceneId, "mep-sub-2026")
  assert.ok(state.menus.slice(1).some(menu => menu.includes("submitFindings")))
  assert.equal(stopped.sceneSelection?.status, "needs-confirmation", "original result is immutable")
})
