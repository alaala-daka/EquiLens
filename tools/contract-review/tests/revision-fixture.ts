import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { blankDocx } from "../../../src/lib/documents/docx"
import { parseDocxBytes } from "../src/document"
import { reviewContract } from "../src/review"
import { testPack, validModel } from "./helpers"
import { revisedParagraphs, type RevisionState, type RevisionAudit } from "../src/revision"
import { draftHash, revisionHash } from "../src/agent/revision"

export const revisionTestSkill = { id: "mep-revision" as const, name: "合成修订", description: "测试", version: "test", instructions: "仅合成测试", sha256: "synthetic" }
const skill = revisionTestSkill

export async function revisionFixture() {
  const files = unzipSync(new Uint8Array(await blankDocx().arrayBuffer()))
  files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("<w:p/>", '<w:p><w:r><w:t>进度款按60%支付。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>交接界面。</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>其余约定保持。</w:t></w:r></w:p>'))
  const bytes = zipSync(files), paragraphs = parseDocxBytes(bytes), pack = testPack()
  const primary = await reviewContract({ documentText: paragraphs.map(item => item.text).join("\n"), pack, model: validModel, context: { role: "专业分包人", region: "上海" } })
  primary.paragraphs = paragraphs
  for (const [index, item] of primary.findings.entries()) if (index < 2) Object.assign(item, { kind: "发现问题", quote: paragraphs[index].text, paragraphIndex: index })
  const draft: RevisionState = { id: "synthetic", primarySha256: revisionHash(primary), inputSha256: primary.input.textSha256,
    skillSha256: skill.sha256, sha256: "", status: "completed", callsUsed: primary.callsUsed, usage: null, errors: [],
    edits: [{ id: "E1", operation: "replace", paragraphIndex: 0, before: paragraphs[0].text, after: "进度款按60%支付，支付时间由双方书面确认。", ruleIds: ["T-001"] },
      { id: "E2", operation: "replace", paragraphIndex: 1, before: paragraphs[1].text, after: "交接界面应经双方书面确认。", ruleIds: ["T-002"] },
      { id: "E3", operation: "insert-after", paragraphIndex: 2, before: paragraphs[2].text, after: "补充约定须经双方确认。", ruleIds: ["T-001"] }],
    decisions: primary.findings.map((item, index) => ({ ruleId: item.ruleId, action: index < 2 ? "changed" : "unchanged", editIds: index === 0 ? ["E1", "E3"] : index === 1 ? ["E2"] : [], reason: "合成处理说明。" })), paragraphs: [],
  }
  draft.paragraphs = revisedParagraphs(primary.paragraphs, draft.edits); draft.sha256 = draftHash(draft)
  const audit: RevisionAudit = { draftSha256: draft.sha256, primarySha256: draft.primarySha256, status: "completed", callsUsed: primary.callsUsed, usage: null, errors: [],
    checks: primary.findings.map(item => ({ ruleId: item.ruleId, outcome: "已处理", note: "合成核对，不作为法律质量结果。", paragraphIndex: 0, quote: draft.paragraphs[0].text, basis: ["S-1"] })) }
  return { bytes, primary, draft, audit, pack }
}
