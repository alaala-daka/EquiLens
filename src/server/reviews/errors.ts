/**
 * A4c project contract-review failure codes.
 *
 * These are controlled, product-facing failures: the executor returns them as
 * the task's terminal error code (or rethrows ACCESS_REVOKED to the unified
 * runner) instead of leaking model/SQL details. Messages are fixed strings.
 */
export type ProjectReviewFailureCode =
  | "INVALID_SOURCE"
  | "RETENTION_EXPIRED"
  | "SERVICE_UNAVAILABLE"
  | "INVALID_SUBMISSION"
  | "UNREVIEWED_MATERIALS_CONSENT"
  | "REVIEW_INPUT_TOO_LARGE"
  | "RESULT_INVALID"
  | "RESULT_MISMATCH"
  | "RESULT_SAVE_FAILED"
  | "REVIEW_BUDGET_EXHAUSTED"
  | "REVIEW_RESERVATION_FAILED"

export const projectReviewFailureMessages: Record<ProjectReviewFailureCode, string> = {
  INVALID_SOURCE: "所选材料版本、解析快照或原件不可用，未调用模型。",
  RETENTION_EXPIRED: "项目或材料已超过保留期限，不能发起审查。",
  SERVICE_UNAVAILABLE: "材料或成果服务暂时不可用，请稍后重试。",
  INVALID_SUBMISSION: "任务输入清单无效，不能执行审查。",
  UNREVIEWED_MATERIALS_CONSENT: "请确认本次审查使用未签核规则与未核对材料。",
  REVIEW_INPUT_TOO_LARGE: "所选材料正文超过本次审查输入上限，请减少材料后重新提交。",
  RESULT_INVALID: "机器成果未通过服务端校验，任务已停止；原始结果已保留，不能复核或导出。",
  RESULT_MISMATCH: "机器输出与本任务输入不一致，任务已停止，未保存成果。",
  RESULT_SAVE_FAILED: "机器成果保存失败，任务已停止。",
  REVIEW_BUDGET_EXHAUSTED: "本次审查已达到模型调用或费用预算上限。",
  REVIEW_RESERVATION_FAILED: "发送前权限或预算预留检查未通过。",
}

export class ProjectReviewError extends Error {
  constructor(readonly code: ProjectReviewFailureCode) {
    super(projectReviewFailureMessages[code])
    this.name = "ProjectReviewError"
  }
}

/** True for the executor's controlled failures (safe to surface code + fixed message). */
export function isProjectReviewError(failure: unknown): failure is ProjectReviewError {
  return failure instanceof ProjectReviewError
}

/** Task errors keep their code; they only describe a refused execution, never provider detail. */
export function taskFailureCode(failure: unknown): string | null {
  const code = failure && typeof failure === "object" && "code" in failure ? String((failure as { code?: unknown }).code ?? "") : ""
  return code && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null
}
