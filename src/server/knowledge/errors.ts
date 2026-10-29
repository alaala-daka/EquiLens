/**
 * C6 publication maintenance failure codes.
 *
 * The private CLI is the only caller; no HTTP route exposes these. Messages are
 * fixed, operator-facing strings and never include SQL, credentials, stored
 * payload text or file paths. Unknown failures are mapped to a generic message
 * by the CLI so provider details are not printed.
 */
export type KnowledgeFailureCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "INVALID_CONTENT"
  | "INVALID_STATE"
  | "SERVICE_UNAVAILABLE"

export const knowledgeFailureMessages: Record<KnowledgeFailureCode, string> = {
  INVALID_INPUT: "发布维护参数或内容无效。",
  NOT_FOUND: "找不到指定的发布记录或版本。",
  CONFLICT: "发布记录已被其他操作改变，请重新读取后再试。",
  FORBIDDEN: "发布维护被拒绝：操作者或领域核对人不符合要求。",
  INVALID_CONTENT: "发布内容未通过校验，不能保存或发布。",
  INVALID_STATE: "当前发布状态不允许该操作。",
  SERVICE_UNAVAILABLE: "发布服务暂时不可用。",
}

export class KnowledgeError extends Error {
  constructor(readonly code: KnowledgeFailureCode, detail?: string) {
    super(detail ? `${knowledgeFailureMessages[code]}${detail}` : knowledgeFailureMessages[code])
    this.name = "KnowledgeError"
  }
}

/** Reject a failure that is not a controlled publication error. */
export function isKnowledgeError(failure: unknown): failure is KnowledgeError {
  return failure instanceof KnowledgeError
}
