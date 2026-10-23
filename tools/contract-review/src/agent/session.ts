import { ReviewError } from "../errors"
import { prepareReviewInput, type ReviewInput } from "../input"
import { applicability, matchRules, normalize } from "../match"
import { publishedRules, publishedSources } from "../pack"
import { buildSegments } from "../segments"
import type { Finding, LoadedPack, ReviewResult, SourceEntry, TriggeredRule } from "../types"
import { buildCoverage, validateFindings, type RawFinding } from "../validate"
import type { ReviewSkill } from "./skill"
import { citationListSchema } from "./schema"

export class ReviewSession {
  readonly result: ReviewResult
  readonly planned: TriggeredRule[] = []
  readonly blocked = new Map<string, string>()
  readonly sources: SourceEntry[]
  readonly segments: ReturnType<typeof buildSegments>
  readonly readIndexes = new Set<number>()
  readonly readSourceIds = new Set<string>()
  private readonly pendingIndexes = new Set<number>()
  private readonly pendingSourceIds = new Set<string>()
  private readonly accepted = new Map<string, Finding>()

  constructor(input: ReviewInput, pack: LoadedPack, readonly skill: ReviewSkill, model: string, callsUsed: number,
    private readonly maxToolChars: number) {
    const prepared = prepareReviewInput(input, pack, model, callsUsed)
    this.result = prepared.result
    this.result.agent = {
      engine: "ai-sdk", skill: { id: skill.id, version: skill.version, sha256: skill.sha256, loaded: false },
      readParagraphIndexes: [], readSourceIds: [], events: [], submissions: [],
    }
    this.segments = buildSegments(prepared.paragraphs)
    const rules = prepared.pack.manifest.status === "已停用" ? [] : this.result.mode === "debug"
      ? prepared.pack.rules.filter(rule => rule.status !== "已停用") : publishedRules(prepared.pack)
    this.sources = prepared.pack.manifest.status === "已停用" ? [] : (this.result.mode === "debug"
      ? prepared.pack.sources.filter(source => source.status !== "已停用") : publishedSources(prepared.pack))
      .filter(source => source.text?.trim())
    const usable = new Set(this.sources.map(source => source.sourceId))
    let excluded = 0
    for (const rule of rules) {
      const applies = applicability(rule, prepared.context)
      if (applies === "excluded") { excluded++; this.result.warnings.push(rule.ruleId + "：适用条件不符，本次排除。"); continue }
      const entry = matchRules([{ ...rule, appliesTo: {} }], prepared.paragraphs)[0]
      if (!entry) {
        this.result.notLocated.push({ ruleId: rule.ruleId, reason: "no-match", detail: "非必检规则未命中，未纳入本次检查。" })
        continue
      }
      this.planned.push(entry)
      if (applies === "unknown") this.blocked.set(rule.ruleId, "审查立场、项目类型或地域等适用条件尚未确认。")
      else if (rule.basis.some(item => !usable.has(item.sourceId))) this.blocked.set(rule.ruleId, "必要依据尚未发布或缺少正文。")
    }
    if (!this.planned.length) {
      // 区分"条件不符"与"规则没命中内容"，两种原因给用户的下一步动作不同。
      const code = !rules.length ? "REVIEW_RULES_UNAVAILABLE" : excluded ? "REVIEW_CONTEXT_UNMATCHED" : "REVIEW_RULES_UNMATCHED"
      this.result.errors.push({ code, message: new ReviewError(code).message, ruleIds: [] })
    }
  }

  get loaded() { return this.result.agent!.skill.loaded }
  get fullyRead() { return this.readIndexes.size === this.result.paragraphs.length }
  get canConcludeAbsence() { return this.fullyRead && this.result.input.complete }

  restore(prior: ReviewResult) {
    if (prior.input.textSha256 !== this.result.input.textSha256 || prior.packVersion !== this.result.packVersion ||
        prior.agent?.skill.sha256 !== this.skill.sha256 || prior.input.documentVersionId !== this.result.input.documentVersionId ||
        prior.input.parseSnapshotId !== this.result.input.parseSnapshotId) throw new ReviewError("REVIEW_INPUT_INVALID")
    for (const finding of prior.findings) {
      // 后端补出的占位项没有检查范围；恢复只保留曾经通过校验的模型提交。
      if (finding.checkedParagraphIndexes && this.planned.some(item => item.rule.ruleId === finding.ruleId)) this.accepted.set(finding.ruleId, structuredClone(finding))
    }
    this.result.rejected = structuredClone(prior.rejected)
    this.result.agent!.events = structuredClone(prior.agent.events)
    this.result.agent!.submissions = structuredClone(prior.agent.submissions)
  }

  checkpoint(): ReviewResult {
    return structuredClone({ ...this.result, findings: [...this.accepted.values()],
      coverage: buildCoverage([...this.accepted.values()], this.planned),
      agent: { ...this.result.agent!, readParagraphIndexes: [...this.readIndexes], readSourceIds: [...this.readSourceIds] } })
  }

  /** 下一次模型请求已带上工具结果并成功返回，才算正文/依据实际交给模型。
   * 同一模型回合预先生成的 read + submit 不能借工具执行顺序伪造阅读。 */
  commitReads() {
    for (const index of this.pendingIndexes) this.readIndexes.add(index)
    for (const id of this.pendingSourceIds) this.readSourceIds.add(id)
    this.pendingIndexes.clear()
    this.pendingSourceIds.clear()
  }

  private requireSkill() { if (!this.loaded) throw new ReviewError("REVIEW_SKILL_REQUIRED") }
  private bounded<T>(value: T): T {
    if (JSON.stringify(value).length > this.maxToolChars) throw new ReviewError("REVIEW_INPUT_TOO_LARGE")
    return value
  }
  record(tool: string, detail: { paragraphIndexes?: number[]; sourceIds?: string[]; ruleIds?: string[] } = {}) {
    this.result.agent!.events.push({ tool, at: new Date().toISOString(), ...detail })
  }

  loadSkill(id: string) {
    if (id !== this.skill.id) throw new ReviewError("REVIEW_SKILL_INVALID")
    const response = this.bounded({
      id, version: this.skill.version, sha256: this.skill.sha256, instructions: this.skill.instructions,
      context: this.result.input.context, mode: this.result.mode, warnings: this.result.warnings,
      rules: this.planned.map(({ rule }) => ({
        ruleId: rule.ruleId, title: rule.title, category: rule.category, appliesTo: rule.appliesTo,
        mandatory: rule.mandatory !== false, requirement: rule.requirement, severity: rule.severity,
        basis: rule.basis, unavailableReason: this.blocked.get(rule.ruleId),
      })),
    })
    this.result.agent!.skill.loaded = true
    this.record("loadSkill")
    return response
  }

  parseDocument(cursor: number, limit: number) {
    const outline = this.segments.slice(cursor, cursor + limit).map(segment => ({
      id: segment.id, title: segment.title, paragraphIndexes: segment.indexes,
    }))
    const response = this.bounded({
      title: this.result.documentTitle, textSha256: this.result.input.textSha256,
      documentVersionId: this.result.input.documentVersionId, parseSnapshotId: this.result.input.parseSnapshotId,
      complete: this.result.input.complete, paragraphCount: this.result.paragraphs.length,
      segmentCount: this.segments.length, outline,
      nextCursor: cursor + limit < this.segments.length ? cursor + limit : null,
      note: "目录仅供定位，不计为已读正文；正文须通过 readParagraphs 读取。",
    })
    this.record("parseDocument")
    return response
  }

  searchDocument(query: string, cursor: number, limit: number) {
    this.requireSkill()
    const needle = normalize(query)
    if (!needle) throw new ReviewError("REVIEW_INPUT_INVALID")
    const hits = this.result.paragraphs.filter(item => normalize(item.text).includes(needle))
    const response = this.bounded({
      total: hits.length, nextCursor: cursor + limit < hits.length ? cursor + limit : null,
      hits: hits.slice(cursor, cursor + limit).map(item => ({ index: item.index, preview: item.text.slice(0, 120), table: item.table })),
      note: "预览只作定位，未计入已读范围；零命中不能证明条款缺失。",
    })
    this.record("searchDocument")
    return response
  }

  readParagraphs(indexes: number[]) {
    this.requireSkill()
    const wanted = new Set(indexes)
    const paragraphs = this.result.paragraphs.filter(item => wanted.has(item.index))
    if (paragraphs.length !== wanted.size) throw new ReviewError("REVIEW_INPUT_INVALID")
    // 先检查预算，超限不截断，也不把未返回的正文登记为已读。
    const response = this.bounded({
      documentVersionId: this.result.input.documentVersionId, parseSnapshotId: this.result.input.parseSnapshotId,
      paragraphs,
    })
    for (const paragraph of paragraphs) this.pendingIndexes.add(paragraph.index)
    this.record("readParagraphs", { paragraphIndexes: paragraphs.map(item => item.index) })
    return response
  }

  readSources(ids: string[]) {
    this.requireSkill()
    const wanted = new Set(ids)
    const allowed = new Set(this.planned.flatMap(item => item.rule.basis.map(basis => basis.sourceId)))
    const sources = this.sources.filter(source => wanted.has(source.sourceId) && allowed.has(source.sourceId))
    if (sources.length !== wanted.size) throw new ReviewError("REVIEW_SOURCE_UNAVAILABLE")
    const response = this.bounded({ sources })
    for (const source of sources) this.pendingSourceIds.add(source.sourceId)
    this.record("readSources", { sourceIds: sources.map(item => item.sourceId) })
    return response
  }

  submit(raw: RawFinding[]) {
    this.requireSkill()
    const rejectedBefore = this.result.rejected.length
    const eligible = raw.filter(item => {
      const reason = typeof item.ruleId === "string" ? this.blocked.get(item.ruleId) : undefined
      if (!reason || item.kind === "待核实") return true
      this.result.rejected.push({ ruleId: String(item.ruleId), reason: "适用条件或依据不足", detail: reason })
      return false
    })
    const withValidCitations = eligible.filter(item => {
      const parsed = citationListSchema.safeParse(item.citations ?? [])
      if (parsed.success && !(item.kind === "缺失条款" && parsed.data.length) && parsed.data.every(citation =>
        this.readIndexes.has(citation.paragraphIndex) && this.result.paragraphs.some(paragraph =>
          paragraph.index === citation.paragraphIndex && paragraph.text.includes(citation.quote)))) return true
      this.result.rejected.push({ ruleId: String(item.ruleId), reason: "引文校验失败", detail: "补充引文必须逐字出现在已读段落中；缺失条款不得附带虚构引文。" })
      return false
    })
    const outcome = validateFindings(withValidCitations, this.planned,
      this.result.paragraphs.filter(item => this.readIndexes.has(item.index)), this.readSourceIds, this.canConcludeAbsence)
    this.result.rejected.push(...outcome.rejected)
    const range = [...this.readIndexes].sort((a, b) => a - b)
    this.result.agent!.submissions.push({
      ruleIds: raw.map(item => String(item.ruleId)), readParagraphIndexes: range, readSourceIds: [...this.readSourceIds],
    })
    for (const finding of outcome.findings) {
      const paragraph = this.result.paragraphs.find(item => item.index === finding.paragraphIndex)
      finding.checkedParagraphIndexes = [...range]
      finding.citations = finding.quote && paragraph ? [{
        documentVersionId: this.result.input.documentVersionId, parseSnapshotId: this.result.input.parseSnapshotId,
        paragraphIndex: paragraph.index, quote: finding.quote, table: paragraph.table,
      }] : []
      const extra = citationListSchema.parse(withValidCitations.find(item => item.ruleId === finding.ruleId)?.citations ?? [])
      for (const citation of extra) {
        if (finding.citations.some(item => item.paragraphIndex === citation.paragraphIndex && item.quote === citation.quote)) continue
        const location = this.result.paragraphs.find(item => item.index === citation.paragraphIndex)!
        finding.citations.push({ ...citation, documentVersionId: this.result.input.documentVersionId,
          parseSnapshotId: this.result.input.parseSnapshotId, table: location.table })
      }
      finding.sourceReferences = finding.basis.map(id => {
        const source = this.sources.find(item => item.sourceId === id)!
        return { sourceId: id, type: source.type, name: source.name, article: source.article,
          version: source.version, officialUrl: source.officialUrl, status: source.status }
      })
      this.accepted.set(finding.ruleId, finding)
    }
    this.record("submitFindings", { ruleIds: raw.map(item => String(item.ruleId)) })
    return { acceptedRuleIds: outcome.findings.map(item => item.ruleId), rejected: this.result.rejected.slice(rejectedBefore),
      blocked: raw.flatMap(item => typeof item.ruleId === "string" && this.blocked.has(item.ruleId)
        ? [{ ruleId: item.ruleId, reason: this.blocked.get(item.ruleId) }] : []), ...this.checkCoverage() }
  }

  checkCoverage() {
    const findings = [...this.accepted.values()]
    return {
      coverage: buildCoverage(findings, this.planned),
      unansweredRuleIds: this.planned.filter(item => !this.accepted.has(item.rule.ruleId)).map(item => item.rule.ruleId),
      readParagraphCount: this.readIndexes.size, paragraphCount: this.result.paragraphs.length,
      canConcludeAbsence: this.canConcludeAbsence,
    }
  }

  finish(): ReviewResult {
    const hasAccepted = this.accepted.size > 0
    for (const { rule } of this.planned) {
      if (this.accepted.has(rule.ruleId)) continue
      const reason = this.blocked.get(rule.ruleId) ?? "该必检项尚未取得有效结论，需要补读或重新审查。"
      this.accepted.set(rule.ruleId, {
        ruleId: rule.ruleId, category: rule.category, kind: "待核实", risk: reason,
        severity: rule.severity, severityOrigin: "规则预设", quote: "", paragraphIndex: -1,
        basis: [], impact: "", suggestion: "补充所需材料或完成检查后重新审查。", pending: [reason], reviewStatus: "待人工复核",
      })
    }
    this.result.findings = [...this.accepted.values()]
    this.result.coverage = buildCoverage(this.result.findings, this.planned)
    this.result.agent!.readParagraphIndexes = [...this.readIndexes].sort((a, b) => a - b)
    this.result.agent!.readSourceIds = [...this.readSourceIds]
    this.result.summary = {
      issues: this.result.findings.filter(item => ["发现问题", "缺失条款"].includes(item.kind)).length,
      pending: this.result.findings.filter(item => item.kind === "待核实").length,
      rejected: this.result.rejected.length, unreadParagraphs: this.result.paragraphs.length - this.readIndexes.size,
    }
    if (!this.fullyRead) this.result.warnings.push("存在尚未读取的正文；局部结果不能作为完整无风险或条款缺失结论。")
    const complete = this.loaded && this.canConcludeAbsence && !this.result.errors.length && !this.result.notLocated.length &&
      this.result.coverage.every(item => !["未覆盖", "待核实"].includes(item.status)) && this.planned.length > 0
    this.result.status = complete ? "success" : hasAccepted ? "partial" : "failed"
    return this.result
  }
}
