import { contractReviewResultValidator } from "../reviews/registry"
import { ResultValidatorRegistry, type ResultValidator } from "./validation"

/**
 * A4c production result-validator registry.
 *
 * Only server-owned business validators are registered here. Test fixtures
 * (including A4a/A4b synthetic "test" kinds) must never be added: they are
 * constructed per test and stay out of the production registry. Unknown kinds
 * keep failing closed with SERVICE_UNAVAILABLE.
 */
export function productionResultValidators(): ResultValidatorRegistry {
  const validators = new Map<string, ResultValidator>([
    ["contract-review", contractReviewResultValidator],
  ])
  return new ResultValidatorRegistry(validators)
}
