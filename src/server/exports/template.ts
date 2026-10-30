import { bidVerificationReportTemplate } from "../verification/export-template"
import { specialtySubcontractExportTemplate, supplementaryAgreementExportTemplate } from "../drafting/export-template"
import { contractReviewReportTemplateV2 } from "../reviews/export-template"
import { ExportTemplateRegistry } from "./service"
import { paymentReconciliationExportTemplate } from "../payments/export-template"
import { evidenceReportExportTemplate } from "../evidence/export-template"
export { contractReviewReportTemplate } from "../reviews/export-template"

/** Templates render selected saved values; prior exports retain their original bytes. */
export function productionExportTemplates(): ExportTemplateRegistry {
  return new ExportTemplateRegistry(new Map([
    ["payment-reconciliation", paymentReconciliationExportTemplate],
    ["evidence-report", evidenceReportExportTemplate],
    ["contract-review", contractReviewReportTemplateV2],
    ["bid-verification", bidVerificationReportTemplate],
    ["specialty-subcontract", specialtySubcontractExportTemplate],
    ["supplementary-agreement", supplementaryAgreementExportTemplate],
  ]))
}
