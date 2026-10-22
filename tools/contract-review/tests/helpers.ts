import { CHECK_CATEGORIES, type LoadedPack, type RuleEntry } from "../src/types"
import type { AskModel } from "../src/review"

export const rule = (overrides: Partial<RuleEntry> = {}): RuleEntry => ({
  ruleId: "T-001", category: "付款条件与时间", title: "合成检查",
  status: "已发布", appliesTo: {}, mandatory: true, trigger: { keywords: ["付款"] },
  requirement: "合成业务检查，不用于法律判断。", severity: "一般关注", basis: [{ sourceId: "S-1" }], ...overrides,
})

export const testPack = (rules: RuleEntry[] = CHECK_CATEGORIES.map((category, index) =>
  rule({ category, ruleId: "T-00" + (index + 1) }))): LoadedPack => ({
  manifest: {
    version: "synthetic-v1", name: "合成测试包", status: "已发布", reviewer: "synthetic", reviewedAt: "2026-10-22",
    ruleFiles: ["rules.json"], sourceFiles: ["sources.json"],
  },
  rules, sources: [{
    sourceId: "S-1", type: "企业审查规则", name: "合成测试依据", text: "仅用于测试编排的合成检查要求。",
    status: "已发布", reviewer: "synthetic", reviewedAt: "2026-10-22",
  }], warnings: [],
})

export function answers(user: string) {
  const first = user.match(/\[(\d+)\] ([^\n]+)/)
  return [...user.matchAll(/### 规则 ([A-Z]+-\d+)/g)].map(match => ({
    ruleId: match[1], kind: "未发现问题", risk: "合成检查未发现问题", severity: "一般关注",
    quote: first?.[2] ?? "", paragraphIndex: Number(first?.[1] ?? -1), basis: ["S-1"],
    impact: "", suggestion: "无需修改", pending: [] as string[],
  }))
}

export const validModel: AskModel = async ({ user }) => ({
  text: JSON.stringify({ findings: answers(user) }),
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
})
