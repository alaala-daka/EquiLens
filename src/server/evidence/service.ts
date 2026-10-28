import type { EvidenceItemInput, EvidenceReportInput } from "@/lib/evidence/types"
import type { EvidenceRepository } from "./repository"
import { composeEvidenceReport, evidenceReportMarkdown } from "./report"
import { assertEvidenceReferences, validateEvidenceItem, type EvidenceScope } from "./validation"

/**
 * 证据整理服务：项目、事实、款项和来源通过注入的共享解析器校验；
 * 未接入共享服务前不开放真实业务接口。
 */
export function createEvidenceService(options: { repository: EvidenceRepository; scope: EvidenceScope }) {
  return {
    async saveItem(input: EvidenceItemInput & { itemId?: string }) {
      validateEvidenceItem(input)
      await assertEvidenceReferences(options.scope, input)
      return options.repository.saveItem(input)
    },
    async saveReport(input: EvidenceReportInput) {
      const composed = composeEvidenceReport(input)
      const saved = await options.repository.saveReport(composed)
      return { report: saved, markdown: evidenceReportMarkdown(saved) }
    },
  }
}
