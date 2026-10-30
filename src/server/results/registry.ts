import { contractReviewResultValidator } from "../reviews/registry"
import { specialtySubcontractValidator, supplementaryAgreementValidator } from "../drafting/validation"
import { bidRequirementSetValidator } from "../verification/requirements"
import { bidVerificationResultValidator } from "../verification/validation"
import { ResultValidatorRegistry, type ResultValidator } from "./validation"
import { factCandidatesValidator } from "../facts/result-validator"
import { paymentReconciliationValidator } from "../payments/result-validator"
import { evidenceReportValidator } from "../evidence/result-validator"
import { collectionLetterValidator } from "../letters/validation"

/**
 * A4c/C4 production result-validator registry.
 *
 * Only server-owned business validators are registered here. Test fixtures
 * (including A4a/A4b synthetic "test" kinds) must never be added: they are
 * constructed per test and stay out of the production registry. Unknown kinds
 * keep failing closed with SERVICE_UNAVAILABLE.
 */
export function productionResultValidators(): ResultValidatorRegistry {
  const validators = new Map<string, ResultValidator>([
    ["fact-candidates", factCandidatesValidator],
    ["payment-reconciliation", paymentReconciliationValidator],
    ["evidence-report", evidenceReportValidator],
    ["collection-letter", collectionLetterValidator],
    ["contract-review", contractReviewResultValidator],
    ["bid-requirements", bidRequirementSetValidator],
    ["bid-verification", bidVerificationResultValidator],
    ["specialty-subcontract", specialtySubcontractValidator],
    ["supplementary-agreement", supplementaryAgreementValidator],
  ])
  return new ResultValidatorRegistry(validators)
}
