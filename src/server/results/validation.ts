import type { ResultValidation } from "../../lib/business/contracts"
import { BusinessError } from "../projects/errors"

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`
  }
  throw new BusinessError("INVALID_INPUT", "成果内容无效。")
}
export type ResultValidator = (value: unknown) => Promise<Pick<ResultValidation, "status" | "issues">>
/** Construct only from server-owned business validators. Production starts empty. */
export class ResultValidatorRegistry {
  constructor(private readonly validators: ReadonlyMap<string, ResultValidator> = new Map()) {}
  require(kind: string): ResultValidator {
    const validator = this.validators.get(kind)
    if (!validator) throw new BusinessError("SERVICE_UNAVAILABLE", "该成果类型尚未开放。")
    return validator
  }
}
