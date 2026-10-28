import assert from "node:assert/strict"
import { test } from "node:test"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { parseDocxBytes } from "../src/document"
import { canExportRevision, revisedParagraphs, validateRevision } from "../src/revision"
import { draftHash, reviseContract, auditRevisedContract, REVISION_AUDIT_BATCH_SIZE } from "../src/agent/revision"
import { buildRevisionDocx } from "../src/revision-docx"
import { renderRevisionInChild } from "../src/revision-export"

const env = { AI_BASE_URL: "https://synthetic.invalid/v1", AI_MODEL: "synthetic", AI_API_KEY: "synthetic-no-network" }
import { revisionFixture, revisionTestSkill as skill } from "./revision-fixture"

test("WD-02/08/AC-11: revised DOCX preserves untouched content, table, source bytes and package parts", async () => {
  const { bytes, primary, draft, audit } = await revisionFixture()
  const before = Uint8Array.from(bytes)
  const output = buildRevisionDocx(bytes, primary, draft, audit)
  assert.deepEqual(bytes, before)
  const paragraphs = parseDocxBytes(output)
  assert.match(paragraphs[0].text, /AI 生成，待人工审核/)
  assert.equal(paragraphs[1].text, draft.edits[0].after)
  assert.equal(paragraphs[2].text, draft.edits[1].after)
  assert.deepEqual(paragraphs[2].table, primary.paragraphs[1].table)
  assert.equal(paragraphs[3].text, "其余约定保持。")
  assert.equal(paragraphs[4].text, draft.edits[2].after)
  const originalFiles = unzipSync(bytes), newFiles = unzipSync(output)
  for (const name of Object.keys(originalFiles).filter(name => name !== "word/document.xml")) assert.deepEqual(newFiles[name], originalFiles[name])
  const child = await renderRevisionInChild(Buffer.from(bytes), primary, draft, audit, new AbortController().signal)
  assert.deepEqual(parseDocxBytes(child), paragraphs)
  const marked = unzipSync(bytes)
  marked["word/document.xml"] = strToU8(strFromU8(marked["word/document.xml"]).replace("<w:r>", '<w:bookmarkStart w:id="1" w:name="contract"/><w:bookmarkEnd w:id="1"/><w:r>'))
  assert.throws(() => buildRevisionDocx(zipSync(marked), primary, draft, audit), /内联结构/)
  const attributed = unzipSync(bytes)
  attributed["word/document.xml"] = strToU8(strFromU8(attributed["word/document.xml"]).replace("<w:r>", '<w:r w:rsidR="00ABCDEF">'))
  assert.doesNotThrow(() => buildRevisionDocx(zipSync(attributed), primary, draft, audit))
})

test("AC-03/20/21: fake anchors, overlap, missing decisions, critical changes and introduced identities fail", async () => {
  const { primary, draft } = await revisionFixture()
  assert.equal(validateRevision(primary, draft.edits, draft.decisions), true)
  assert.equal(validateRevision(primary, draft.edits, draft.decisions.slice(1)), false)
  for (const patch of [{ before: "伪造原文" }, { after: "进度款按80%支付。" }, { after: "进度款支付。" },
    { after: "进度款按60%支付，付款期限为【待确认：30天】。" }, { after: "进度款按60%支付，联系人为新经办人。" },
    { after: "进度款按60%支付，由合成新设仲裁委员会处理争议。" }, { ruleIds: ["UNKNOWN"] }]) {
    assert.throws(() => validateRevision(primary, [{ ...draft.edits[0], ...patch }, ...draft.edits.slice(1)], draft.decisions))
  }
  assert.throws(() => validateRevision(primary, [...draft.edits, { ...draft.edits[0], id: "duplicate" }], draft.decisions))
  assert.throws(() => validateRevision(primary, [draft.edits[0]], [{ ruleId: "T-002", action: "pending", editIds: ["E1"], reason: "相关修改仍需确认。" }]), /editIds必须为空数组/)
  assert.throws(() => validateRevision(primary, [draft.edits[0]], [{ ruleId: "T-002", action: "changed", editIds: ["E1"], reason: "错误借用其他规则。" }]), /不能借用其他规则/)
  assert.throws(() => validateRevision(primary, [{ ...draft.edits[0], operation: "insert-after", paragraphIndex: 1, before: primary.paragraphs[1].text }, ...draft.edits.slice(1)], draft.decisions))
  assert.doesNotThrow(() => validateRevision(primary, [{ ...draft.edits[0], after: "进度款按60%支付，每逾期一日按【待确认：计算方式】支付违约金。" }, ...draft.edits.slice(1)], draft.decisions))
  assert.throws(() => validateRevision(primary, [{ ...draft.edits[0], after: "进度款按60%支付，付款期限为一日。" }, ...draft.edits.slice(1)], draft.decisions))
  const amount = structuredClone(primary)
  amount.paragraphs[0].text = "金额为10万元，违约金为万分之一。"
  assert.throws(() => validateRevision(amount, [{ ...draft.edits[0], before: amount.paragraphs[0].text, after: "金额为10千元，违约金为万分之一。" }], []))
  assert.throws(() => validateRevision(amount, [{ ...draft.edits[0], before: amount.paragraphs[0].text, after: "金额为10万元，违约金为千分之一。" }], []))
})

test("AC-20/21: preserve a generic court designation while rejecting added named courts", async () => {
  const { primary, draft } = await revisionFixture()
  primary.paragraphs[0].text = "双方发生争议先协商；协商不成的，向工程所在地有管辖权的人民法院提起诉讼。"
  const edit = { ...draft.edits[0], before: primary.paragraphs[0].text,
    after: "双方先协商，期限为【待确认：协商期限】；协商不成的，任何一方均可向工程所在地有管辖权的人民法院提起诉讼。" }
  assert.doesNotThrow(() => validateRevision(primary, [edit], []))
  assert.throws(() => validateRevision(primary, [{ ...edit, after: edit.after.replace("工程所在地有管辖权的人民法院", "北京市第一中级人民法院") }], []), /机构/)
  assert.throws(() => validateRevision(primary, [{ ...edit, after: edit.after.replace("工程所在地有管辖权的人民法院", "北京市工程所在地有管辖权的人民法院") }], []), /机构/)
  assert.throws(() => validateRevision(primary, [{ ...edit, after: edit.after.replace("工程所在地有管辖权的人民法院", "上海仲裁委员会") }], []), /机构/)
})

test("AC-20/21: suggested replacement retains an explicit original value and confirmation marker", async () => {
  const { primary, draft } = await revisionFixture()
  primary.paragraphs[0].text = "8.1  每逾期一日按合同价款的1%支付违约金。"
  const edit = { ...draft.edits[0], before: primary.paragraphs[0].text,
    after: "8.1  每逾期一日按合同价款的【待确认：日违约金比例】支付违约金。",
    valueChanges: [{ original: "1%", placeholder: "【待确认：日违约金比例】" }] }
  assert.doesNotThrow(() => validateRevision(primary, [edit], []))
  assert.throws(() => validateRevision(primary, [{ ...edit, valueChanges: [] }], []))
  assert.throws(() => validateRevision(primary, [{ ...edit, valueChanges: [{ original: "2%", placeholder: "【待确认：日违约金比例】" }] }], []))
  assert.throws(() => validateRevision(primary, [{ ...edit, after: "8.1  每逾期一日按合同价款的2%支付违约金。" }], []))
  const inserted = { ...draft.edits[0], operation: "insert-after" as const, before: primary.paragraphs[0].text, after: "11.4  不可抗力通知期限为【待确认：通知期限】。" }
  assert.doesNotThrow(() => validateRevision(primary, [inserted], []))
  primary.paragraphs[2].text = "3.1  合同工期。"
  assert.doesNotThrow(() => validateRevision(primary, [{ ...inserted, after: "履行程序按第3.1条执行。" }], []))
  assert.throws(() => validateRevision(primary, [{ ...inserted, after: "履行程序按第9.9条执行。" }], []), /编号不存在/)
})

test("AC-23: repeated rejected changes retain original text and become pending without looping", async () => {
  const { primary, pack } = await revisionFixture()
  let calls = 0
  const result = await reviseContract({ primary, pack, skill, env, strategy: "prepared-v1", maxCalls: 25,
    fetcher: async (_url, init) => {
      calls++
      const data = JSON.parse(JSON.parse(String(init?.body)).messages.find((item: { role: string }) => item.role === "user").content)
      const id = data.targetRuleIds[0]
      const argument = { edits: [], decisions: [{ ruleId: id, action: "changed", editIds: ["missing"], reason: "不存在的修改。" }] }
      return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: `call-${calls}`, type: "function", function: { name: "submitRevision", arguments: JSON.stringify(argument) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    } })
  assert.equal(result.status, "completed")
  assert.ok(result.decisions.some(item => item.action === "pending" && item.reason.includes("未通过校验")))
  assert.deepEqual(result.paragraphs, primary.paragraphs)
  assert.ok(calls <= 4)
})

test("AC-09/11/21: changed draft, incomplete audit and new risks block Word; pending inputs remain in draft", async () => {
  const { bytes, primary, draft, audit } = await revisionFixture()
  assert.equal(canExportRevision(draft, audit), true)
  for (const changed of [{ ...audit, status: "partial" as const }, { ...audit, draftSha256: "changed" }, { ...audit, checks: audit.checks.slice(1) },
    { ...audit, checks: audit.checks.map((item, index) => index ? item : { ...item, outcome: "存在问题" as const }) }]) {
    assert.equal(canExportRevision(draft, changed), false)
    assert.throws(() => buildRevisionDocx(bytes, primary, draft, changed))
  }
  draft.decisions[0] = { ruleId: "T-001", action: "pending", editIds: [], reason: "请确认结算款支付期限。" }
  draft.edits = draft.edits.filter(item => !item.ruleIds.includes("T-001"))
  draft.paragraphs = revisedParagraphs(primary.paragraphs, draft.edits); draft.sha256 = draftHash(draft)
  audit.draftSha256 = draft.sha256; audit.checks[0] = { ...audit.checks[0], outcome: "需确认", note: "请确认结算款支付期限。" }
  assert.ok(parseDocxBytes(buildRevisionDocx(bytes, primary, draft, audit)).some(item => item.text === "请确认结算款支付期限。"))
  draft.paragraphs[0].text = "私自替换正文"
  assert.throws(() => buildRevisionDocx(bytes, primary, draft, audit))
})

test("AC-23/24: independent revision generation and audit use separate tools, shared budget and resumable checks", async () => {
  const { primary, draft, pack } = await revisionFixture()
  const menus: string[][] = [], reservations: number[] = []
  let auditCalls = 0, refuse = true
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)), menu = body.tools.map((item: { function: { name: string } }) => item.function.name)
    menus.push(menu)
    const name = menu[0]
    let input: unknown
    if (name === "submitRevision") input = { edits: draft.edits, decisions: draft.decisions.filter(item => item.action === "changed") }
    else {
      auditCalls++
      if (auditCalls === 2 && refuse) { refuse = false; return Response.json({ choices: [{ finish_reason: "content_filter", message: { content: null } }] }) }
      const data = JSON.parse(body.messages.at(-1).content)
      input = { checks: data.targetRuleIds.map((ruleId: string) => ({ ruleId, outcome: "已处理", note: "合成独立核对。", paragraphIndex: 0, quote: data.revisedParagraphs[0].text, basis: ["S-1"] })) }
    }
    return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "synthetic-" + menus.length, type: "function", function: { name, arguments: JSON.stringify(input) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  }
  const options = { primary, pack, env, fetcher, maxCalls: 25, onBeforeCall: async (value: { callNumber: number }) => { reservations.push(value.callNumber) } }
  const created = await reviseContract({ ...options, skill })
  assert.equal(created.status, "completed")
  const before = JSON.stringify(created)
  const first = await auditRevisedContract({ ...options, draft: created, callsUsed: created.callsUsed })
  assert.equal(first.status, "partial"); assert.equal(first.checks.length, REVISION_AUDIT_BATCH_SIZE)
  const recovered = await auditRevisedContract({ ...options, draft: created, callsUsed: first.callsUsed, previous: first })
  assert.equal(recovered.status, "completed"); assert.equal(recovered.checks.length, 6)
  assert.equal(JSON.stringify(created), before)
  assert.deepEqual(menus[0], ["submitRevision"])
  assert.ok(menus.slice(1).every(menu => menu.length === 1 && menu[0] === "submitRevisionAudit"))
  assert.deepEqual(reservations, Array.from({ length: menus.length }, (_, index) => primary.callsUsed + index + 1))
  await assert.rejects(auditRevisedContract({ ...options, draft: { ...created, sha256: "changed" }, previous: recovered }), { code: "REVIEW_INPUT_INVALID" })
})

test("AC-09/20/23: an invalid change does not discard another valid change or mark the unfinished issue resolved", async () => {
  const { primary, draft, pack } = await revisionFixture()
  const fetcher: typeof fetch = async () => Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic",
    choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "batch", type: "function", function: {
      name: "submitRevision", arguments: JSON.stringify({ edits: [{ ...draft.edits[0], after: "改为80%支付。" }, draft.edits[1]], decisions: draft.decisions.filter(item => item.action === "changed") }),
    } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  const result = await reviseContract({ primary, pack, skill, env, fetcher, maxCalls: primary.callsUsed + 1 })
  assert.equal(result.status, "partial")
  assert.deepEqual(result.edits.map(item => item.id), ["E2"])
  assert.ok(result.decisions.some(item => item.ruleId === "T-002" && item.action === "changed"))
  assert.ok(!result.decisions.some(item => item.ruleId === "T-001"))
  assert.equal(result.paragraphs[0].text, primary.paragraphs[0].text)
  assert.ok(result.errors.some(item => item.code === "REVIEW_BUDGET_EXHAUSTED"))
})

test("AC-09/20/23: prepared revision uses isolated batches, shrinks truncated output and binds recovery strategy", async () => {
  const { primary, draft, pack } = await revisionFixture()
  let calls = 0; const sizes: number[] = []
  const result = await reviseContract({ primary, pack, skill, env, strategy: "prepared-v1", reasoningEffort: "low", maxCalls: 25,
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages.find((message: { role: string }) => message.role === "user").content)
      calls++; sizes.push(data.targetRuleIds.length)
      assert.equal(body.messages.length, 2)
      assert.equal(body.reasoning_effort, "low")
      assert.equal(data.findings.length, data.targetRuleIds.length)
      if (calls === 1) return Response.json({ choices: [{ finish_reason: "length", message: { content: null } }], usage: { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292 } })
      const ids: string[] = data.targetRuleIds
      const edits = draft.edits.filter(item => item.ruleIds.every(id => ids.includes(id)))
      const decisions = draft.decisions.filter(item => ids.includes(item.ruleId))
      return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "isolated-revision", type: "function", function: { name: "submitRevision", arguments: JSON.stringify({ edits, decisions }) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    } })
  assert.equal(result.status, "completed")
  assert.deepEqual(sizes, [2, 1, 1])
  assert.equal(result.usage?.totalTokens, 8532)
  assert.deepEqual(result.edits.map(item => item.id).sort(), draft.edits.map(item => item.id).sort())
  await assert.rejects(reviseContract({ primary, pack, skill, env, previous: result, callsUsed: result.callsUsed }), { code: "REVIEW_INPUT_INVALID" })
})

test("AC-09/23: prepared revision recovery preserves accepted edits and requests only unfinished issues", async () => {
  const { primary, draft, pack } = await revisionFixture()
  const targets: string[][] = []
  const fetcher: typeof fetch = async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages.find((item: { role: string }) => item.role === "user").content)
    targets.push(data.targetRuleIds)
    const ids = targets.length === 1 ? ["T-001"] : ["T-002"]
    return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "recover-batch", type: "function", function: { name: "submitRevision", arguments: JSON.stringify({
        edits: draft.edits.filter(item => item.ruleIds.every(id => ids.includes(id))), decisions: draft.decisions.filter(item => ids.includes(item.ruleId)),
      }) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
  }
  const settings = { primary, pack, skill, env, fetcher, strategy: "prepared-v1" as const }
  const first = await reviseContract({ ...settings, onBeforeCall: async value => { if (value.callNumber === primary.callsUsed + 2) throw new Error("synthetic interrupted reservation") } })
  assert.equal(first.status, "partial")
  assert.equal(first.callsUsed, primary.callsUsed + 1)
  const saved = structuredClone(first.edits)
  const second = await reviseContract({ ...settings, callsUsed: first.callsUsed, previous: first })
  assert.equal(second.status, "completed")
  assert.deepEqual(targets, [["T-001", "T-002"], ["T-002"]])
  assert.deepEqual(second.edits.filter(item => saved.some(old => old.id === item.id)), saved)
  assert.equal(second.usage?.totalTokens, 240)
})

test("AC-21/23: prepared revised-body audit retains valid peers and only repeats the rejected item", async () => {
  const { primary, draft, pack } = await revisionFixture()
  const menus: unknown[] = [], batches: string[][] = []
  const result = await auditRevisedContract({ primary, draft, pack, env, strategy: "prepared-v1", fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages.find((item: { role: string }) => item.role === "user").content)
    menus.push(body.tools)
    assert.equal(data.originalParagraphs.length, primary.paragraphs.length)
    assert.equal(data.revisedParagraphs.length, draft.paragraphs.length)
    assert.ok(data.edits.every((item: Record<string, unknown>) => !("before" in item) && !("after" in item)))
    assert.ok(data.originalFindings.every((item: { ruleId: string }) => data.targetRuleIds.includes(item.ruleId)))
    const feedback = body.messages.filter((item: { role: string }) => item.role === "tool").at(-1)
    const ids: string[] = feedback ? JSON.parse(feedback.content).remainingRuleIds : data.targetRuleIds
    batches.push(ids)
    const checks = ids.map((ruleId, index) => ({ ruleId, outcome: "已处理", note: "合成核对。", paragraphIndex: 0,
      quote: menus.length === 1 && index === 0 ? "不存在的引文" : draft.paragraphs[0].text, basis: ["S-1"] }))
    return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "audit", type: "function", function: { name: "submitRevisionAudit", arguments: JSON.stringify({ checks }) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
  } })
  assert.equal(result.status, "completed")
  assert.deepEqual(batches, [["T-001", "T-002", "T-003", "T-004", "T-005"], ["T-001"], ["T-006"]])
  assert.ok(menus.every(menu => JSON.stringify(menu) === JSON.stringify(menus[0])))
  assert.equal(result.checks.length, 6)
  await assert.rejects(auditRevisedContract({ primary, draft, pack, env, previous: result, callsUsed: result.callsUsed }), { code: "REVIEW_INPUT_INVALID" })
})
