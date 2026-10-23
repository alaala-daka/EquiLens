import { modelConfig } from "../../ai/client"
import { ReviewError } from "../../../../tools/contract-review/src/errors"

export function reviewTaskConfig() {
  const production = process.env.NODE_ENV === "production"
  const mode = process.env.AI_REVIEW_MODE ?? (production ? "published" : "debug")
  if (mode !== "debug" && mode !== "published") throw new ReviewError("AI_CONFIG_INVALID")
  const retentionRaw = process.env.AI_REVIEW_RETENTION_DAYS?.trim() || (production ? "" : "7")
  const retentionDays = Number(retentionRaw)
  const maxCalls = Number(process.env.AI_AGENT_MAX_CALLS ?? 25)
  const maxPromptChars = Number(process.env.AI_REVIEW_MAX_PROMPT_CHARS?.trim() || (mode === "debug" ? 240000 : 0))
  if (!/^[1-9]\d*$/.test(retentionRaw) || !Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365 ||
      !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 25) throw new ReviewError("AI_CONFIG_INVALID")
  if (!Number.isSafeInteger(maxPromptChars) || maxPromptChars < 1000 || maxPromptChars > 240000) throw new ReviewError("REVIEW_BUDGET_UNVERIFIED")
  const model = modelConfig(process.env)
  return { mode, retentionDays, maxCalls, maxPromptChars, model: model.model, baseURL: model.endpoint.replace(/\/chat\/completions$/, "") } as const
}
