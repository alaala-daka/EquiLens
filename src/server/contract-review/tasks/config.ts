import { modelConfig } from "../../ai/client"
import { ReviewError } from "../../../../tools/contract-review/src/errors"
import { DEFAULT_AGENT_CALLS, MAX_AGENT_CALLS } from "../../../../tools/contract-review/src/limits"

export function reviewTaskConfig() {
  const production = process.env.NODE_ENV === "production"
  const mode = process.env.AI_REVIEW_MODE ?? (production ? "published" : "debug")
  if (mode !== "debug" && mode !== "published") throw new ReviewError("AI_CONFIG_INVALID")
  const retentionRaw = process.env.AI_REVIEW_RETENTION_DAYS?.trim() || (production ? "" : "7")
  const retentionDays = Number(retentionRaw)
  const maxCalls = Number(process.env.AI_AGENT_MAX_CALLS ?? DEFAULT_AGENT_CALLS)
  const auditEffort = process.env.AI_AUDIT_REASONING_EFFORT ?? "default"
  const primaryEffort = process.env.AI_PRIMARY_REASONING_EFFORT ?? "low"
  const revisionEffort = process.env.AI_REVISION_REASONING_EFFORT ?? "low"
  const maxKnownTokens = Number(process.env.AI_REVIEW_MAX_KNOWN_TOKENS ?? 600000)
  if (![primaryEffort, revisionEffort].every(value => ["default", "low"].includes(value)) ||
    !Number.isSafeInteger(maxKnownTokens) || maxKnownTokens < 10000 || maxKnownTokens > 2000000) throw new ReviewError("AI_CONFIG_INVALID")
  if (auditEffort !== "default" && auditEffort !== "low") throw new ReviewError("AI_CONFIG_INVALID")
  const maxPromptChars = Number(process.env.AI_REVIEW_MAX_PROMPT_CHARS?.trim() || (mode === "debug" ? 240000 : 0))
  if (!/^[1-9]\d*$/.test(retentionRaw) || !Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365 ||
      !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_AGENT_CALLS) throw new ReviewError("AI_CONFIG_INVALID")
  if (!Number.isSafeInteger(maxPromptChars) || maxPromptChars < 1000 || maxPromptChars > 240000) throw new ReviewError("REVIEW_BUDGET_UNVERIFIED")
  const model = modelConfig(process.env)
  return { mode, retentionDays, maxCalls, maxPromptChars, auditEffort, primaryEffort: primaryEffort as "default" | "low",
    revisionEffort: revisionEffort as "default" | "low", maxKnownTokens,
    model: model.model, baseURL: model.endpoint.replace(/\/chat\/completions$/, "") } as const
}
