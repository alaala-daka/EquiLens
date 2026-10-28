import type { BusinessErrorCode } from "../../lib/business/contracts"

/**
 * Project/business error classes shared by the frozen C0 error codes plus
 * the local INVALID_INPUT case (HTTP 400, same as the A1 auth adapter).
 * Every message attached to this class must be a fixed, safe product string:
 * handlers return it verbatim and never expose SQL, credentials or material text.
 */
export type ProjectErrorCode = BusinessErrorCode | "INVALID_INPUT"

const brand = Symbol.for("equilens.business.error")
const codes: readonly ProjectErrorCode[] = [
  "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "LIMIT_EXCEEDED",
  "BUDGET_EXHAUSTED", "INVALID_SOURCE", "SERVICE_UNAVAILABLE", "INVALID_INPUT",
]

export class BusinessError extends Error {
  readonly [brand] = true
  constructor(readonly code: ProjectErrorCode, message: string) {
    super(message)
    this.name = "BusinessError"
  }
}

/** Internal errors cross separately evaluated route bundles; shape checks are faults. */
export function isBusinessError(value: unknown): value is BusinessError {
  if (!value || typeof value !== "object") return false
  const candidate = value as { [brand]?: unknown; code?: unknown; message?: unknown }
  return candidate[brand] === true && typeof candidate.code === "string"
    && codes.includes(candidate.code as ProjectErrorCode) && typeof candidate.message === "string"
}

/**
 * Fixed HTTP status mapping for the frozen C0 business codes plus the local
 * INVALID_INPUT case (400, matching the A1 auth adapter). Validation errors
 * that are not part of C0 stay under INVALID_INPUT so consumers never receive
 * an unmapped code. BUDGET_EXHAUSTED is a state conflict for the caller (409),
 * not a transport failure.
 */
export const httpStatus: Record<ProjectErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 429,
  BUDGET_EXHAUSTED: 409,
  INVALID_SOURCE: 422,
  INVALID_INPUT: 400,
  SERVICE_UNAVAILABLE: 503,
}
