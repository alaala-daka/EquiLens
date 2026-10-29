import type { AuthService } from "../auth/service"
import { KnowledgeError } from "./errors"

/**
 * C6 publication maintenance guards (private CLI only).
 *
 * This is an operational control, not identity proof: the operator must be an
 * existing enabled superadmin account re-read from the auth service, the
 * reviewer must be listed in the deployment's `EQUILENS_DOMAIN_REVIEWERS`
 * allowlist, and reviewer != operator. No real domain reviewer exists in this
 * repository, so these guards do not establish that a real legal review
 * happened (evidence files must say so).
 */
export type PublicationOperator = { id: string; username: string; role: "member" | "superadmin" }

const reviewerPattern = /^[\p{L}\p{N}._@:+-]{1,128}$/u

export async function requireSuperAdminOperator(
  auth: Pick<AuthService, "account">,
  operatorId: string,
): Promise<PublicationOperator> {
  if (typeof operatorId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(operatorId)) {
    throw new KnowledgeError("FORBIDDEN", "未提供有效操作者账号标识。")
  }
  let account: { id: string; username: string; role: "member" | "superadmin" } | null
  try {
    account = await auth.account(operatorId)
  } catch {
    throw new KnowledgeError("SERVICE_UNAVAILABLE", "无法读取操作者账号。")
  }
  if (!account || account.role !== "superadmin") {
    throw new KnowledgeError("FORBIDDEN", "操作者必须是现有且启用的超级管理员账号。")
  }
  return { id: account.id, username: account.username, role: account.role }
}

/** Deployment allowlist; an empty/absent list refuses every publish (fail-closed). */
export function reviewerAllowlist(env: Record<string, string | undefined>): string[] {
  const raw = env.EQUILENS_DOMAIN_REVIEWERS?.trim()
  if (!raw) return []
  return raw.split(",").map(item => item.trim()).filter(item => item.length > 0 && reviewerPattern.test(item)).slice(0, 50)
}

export function requireAllowedReviewer(
  env: Record<string, string | undefined>,
  reviewer: string,
  operator: PublicationOperator,
): string {
  const value = typeof reviewer === "string" ? reviewer.trim() : ""
  if (!reviewerPattern.test(value)) throw new KnowledgeError("FORBIDDEN", "领域核对人标识无效。")
  const allowlist = reviewerAllowlist(env)
  if (!allowlist.length) throw new KnowledgeError("FORBIDDEN", "未配置领域核对人允许清单，不能执行核对。")
  if (!allowlist.includes(value)) throw new KnowledgeError("FORBIDDEN", "领域核对人不在部署允许清单中。")
  const operatorNames = new Set([operator.id.toLowerCase(), operator.username.toLowerCase()])
  if (operatorNames.has(value.toLowerCase())) throw new KnowledgeError("FORBIDDEN", "领域核对人不得与操作者相同。")
  return value
}

/** ISO-8601 UTC instant with milliseconds; must not predate the submitted version. */
export function requireVerifiedAt(value: string, earliest: string, now: Date): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new KnowledgeError("INVALID_INPUT", "核对时间必须是 UTC ISO-8601 时间。")
  }
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) throw new KnowledgeError("INVALID_INPUT", "核对时间无效。")
  const earliestInstant = Date.parse(earliest)
  if (Number.isFinite(earliestInstant) && instant < earliestInstant - 60_000) {
    throw new KnowledgeError("INVALID_INPUT", "核对时间不得早于版本提交时间。")
  }
  if (instant > now.getTime() + 5 * 60_000) throw new KnowledgeError("INVALID_INPUT", "核对时间不得晚于当前时间。")
  return value
}

export function requireReviewEvidence(value: string): string {
  const evidence = typeof value === "string" ? value.trim() : ""
  if (!evidence || evidence.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(evidence)) {
    throw new KnowledgeError("INVALID_INPUT", "核对证据必须为 1—500 个字符的文本。")
  }
  return evidence
}

export function requireReason(value: string): string {
  const reason = typeof value === "string" ? value.trim() : ""
  if (!reason || reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(reason)) {
    throw new KnowledgeError("INVALID_INPUT", "停用原因必须为 1—500 个字符的文本。")
  }
  return reason
}

export function requireExpectedSha256(value: string): string {
  const sha = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new KnowledgeError("INVALID_INPUT", "期望摘要必须是 64 位十六进制 sha256。")
  return sha
}
