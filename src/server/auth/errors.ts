const authErrorBrand = Symbol.for("equilens.auth.error")
export class AuthError extends Error {
  readonly [authErrorBrand] = true
  constructor(readonly code: "INVALID_INPUT" | "ACCOUNT_CONFLICT" | "ACCOUNT_NOT_FOUND" | "INVALID_CREDENTIALS" | "LOGIN_RATE_LIMITED" | "INVALID_ORIGIN" | "AUTH_BUSY" | "UNAUTHENTICATED" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "AUTH_UNAVAILABLE", message: string, readonly retryAfterSeconds?: number) {
    super(message)
    this.name = "AuthError"
  }
}

/** Internal errors cross Next's separately evaluated instrumentation and route bundles. */
export function isAuthError(value: unknown): value is AuthError {
  if (!value || typeof value !== "object" || !(authErrorBrand in value) || value[authErrorBrand] !== true || !("code" in value)) return false
  return ["INVALID_INPUT", "ACCOUNT_CONFLICT", "ACCOUNT_NOT_FOUND", "INVALID_CREDENTIALS", "LOGIN_RATE_LIMITED", "INVALID_ORIGIN", "AUTH_BUSY", "UNAUTHENTICATED", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "AUTH_UNAVAILABLE"].includes(String(value.code))
}