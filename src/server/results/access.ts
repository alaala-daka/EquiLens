import "server-only"
import { applicationDatabase } from "../database/runtime"
import { requireAccount } from "../auth/access"
import { requireProjectAccess } from "../projects/access"
import { ResultRepository } from "./repository"
import { productionResultValidators } from "./registry"
import { ResultService } from "./service"
export async function resultHttpServices() {
  return {
    identity: requireAccount,
    authorize: requireProjectAccess,
    service: new ResultService(
      new ResultRepository(await applicationDatabase()),
      productionResultValidators(),
      // Machine-only kinds: the browser POST and the review/export flows can read
      // them, but only a server-owned task or the explicit server-owned save below
      // may write a value. C4 requirement sets are machine candidates that a human
      // confirms through VerificationService.saveRequirementSet; C5 drafting results
      // are human input composed by the server-owned DraftingService.
      new Set(["fact-candidates", "payment-reconciliation", "evidence-report", "collection-letter", "bid-requirements", "bid-verification", "specialty-subcontract", "supplementary-agreement"]),
      new Set(["payment-reconciliation", "evidence-report", "collection-letter", "bid-requirements", "specialty-subcontract", "supplementary-agreement"]),
      new Set(["contract-review"]),
      new Set(["fact-candidates"]),
    ),
  }
}
