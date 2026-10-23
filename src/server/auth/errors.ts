export class AuthError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "ACCOUNT_CONFLICT" | "ACCOUNT_NOT_FOUND" | "INVALID_CREDENTIALS" | "LOGIN_RATE_LIMITED" | "INVALID_ORIGIN" | "AUTH_BUSY", message: string) {
    super(message)
    this.name = "AuthError"
  }
}
