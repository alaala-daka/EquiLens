import { createHash } from "node:crypto"
import { z } from "zod"
import { TaskError } from "./errors"
import { taskLimits } from "./limits"

/**
 * Server-fixed task catalogue (A3a).
 *
 * The browser may only choose a controlled kind and submit references /
 * conditions validated by the catalogue below. Model addresses, rule text,
 * executors, prompts and a pre-built manifest are rejected: the manifest is
 * assembled server-side and stored immutably with the task.
 */
export const taskKinds = [
  "contract-review",
  "document-analysis",
  "payment-reconciliation",
  "evidence-organization",
  "collection-letter",
  "material-parse",
  "bid-verification",
  "result-export",
] as const
export type TaskKind = (typeof taskKinds)[number]

export const TASK_CATALOG_VERSION = 2

const identifier = z.string().trim().min(1).max(64)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const versionRef = z.object({ projectId: identifier, id: identifier, versionId: identifier }).strict()
const publishedRef = z.object({ id: identifier, versionId: identifier, sha256 }).strict()
const versionRefs = z.array(versionRef).min(1).max(20)
const materialRefs = z.array(z.object({ materialVersionId: identifier, sha256 }).strict()).min(1).max(10)

type TaskDefinition = { maxCalls: number; maxCostFen: number; refs: z.ZodType; conditions: z.ZodType }

// maxCalls is the fixed per-kind paid-call ceiling; 0 means the kind performs no
// paid model/OCR request (budget reservation is then rejected). maxCostFen is the
// server-fixed task cost ceiling in fen. These are conservative Demo budgets:
// real MaaS/OCR prices and the remaining quota must be verified before any
// capacity or cost claim (spec §10.1/§10.2); callers never supply a price,
// budget or model address from the browser.
const definitions: Record<TaskKind, TaskDefinition> = {
  "contract-review": {
    maxCalls: 25,
    maxCostFen: 3000,
    refs: z.object({ materials: materialRefs }).strict(),
    conditions: z.object({
      asOf: day.optional(),
      scene: z.enum(["auto", "mep-sub-2026", "decoration-sub-2026", "curtain-wall-sub-2026", "steel-structure-sub-2026"]),
      role: z.literal("专业分包人"),
      region: z.string().trim().min(1).max(100),
      externalProcessingConsent: z.literal(true),
      unreviewedMaterialsConsent: z.boolean(),
    }).strict(),
  },
  "document-analysis": {
    maxCalls: 3,
    maxCostFen: 300,
    refs: z.object({ document: versionRef }).strict(),
    conditions: z.object({ asOf: day.optional() }).strict(),
  },
  "payment-reconciliation": {
    maxCalls: 3,
    maxCostFen: 300,
    refs: z.object({ document: versionRef, facts: versionRefs, ledger: versionRef.optional() }).strict(),
    conditions: z.object({ asOf: day }).strict(),
  },
  "evidence-organization": {
    maxCalls: 3,
    maxCostFen: 300,
    refs: z.object({ facts: versionRefs, ledger: versionRef.optional() }).strict(),
    conditions: z.object({ asOf: day.optional() }).strict(),
  },
  "collection-letter": {
    maxCalls: 3,
    maxCostFen: 300,
    refs: z.object({ facts: versionRefs, ledger: versionRef.optional(), paymentTaskId: identifier.optional(), evidenceTaskId: identifier.optional() }).strict(),
    conditions: z.object({ template: publishedRef.optional(), asOf: day.optional() }).strict(),
  },
  "material-parse": {
    maxCalls: 0,
    maxCostFen: 0,
    refs: z.object({ materials: materialRefs }).strict(),
    conditions: z.object({}).strict(),
  },
  "bid-verification": {
    maxCalls: 2,
    maxCostFen: 200,
    refs: z.object({ materials: materialRefs }).strict(),
    conditions: z.object({ asOf: day.optional() }).strict(),
  },
  "result-export": {
    maxCalls: 0,
    maxCostFen: 0,
    refs: z.object({ result: versionRef, template: publishedRef.optional() }).strict(),
    conditions: z.object({ format: z.literal("docx") }).strict(),
  },
}

export const operationIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/)

export type TaskRequest = {
  kind: TaskKind
  projectId: string
  refs: unknown
  conditions?: unknown
}

/** Client-facing submission: kind + references + conditions only. */
export type TaskSubmission = TaskRequest & { operationId: string }

export type ParsedTaskRequest = {
  kind: TaskKind
  projectId: string
  refs: Record<string, unknown>
  conditions: Record<string, unknown>
}

export type TaskManifest = {
  version: 1
  catalogVersion: number
  kind: TaskKind
  projectId: string
  refs: Record<string, unknown>
  conditions: Record<string, unknown>
  submittedBy: string
  submittedAt: string
}

const envelopeSchema = z.object({
  kind: z.enum(taskKinds),
  projectId: identifier,
  refs: z.unknown(),
  conditions: z.unknown().optional(),
}).strict()

function invalid(message: string): TaskError {
  return new TaskError(422, "INVALID_SUBMISSION", message)
}

export function maxCallsFor(kind: TaskKind): number {
  return definitions[kind].maxCalls
}

export function maxCostFenFor(kind: TaskKind): number {
  return definitions[kind].maxCostFen
}

/** Reject references that claim another project; project access is re-checked separately. */
function assertProjectScope(projectId: string, value: unknown, path = "refs"): void {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertProjectScope(projectId, item, `${path}[${index}]`))
    return
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "projectId" && typeof item === "string" && item !== projectId) {
      throw invalid("任务引用不属于当前项目。")
    }
    assertProjectScope(projectId, item, `${path}.${key}`)
  }
}

export function parseOperationId(value: unknown): string {
  const parsed = operationIdSchema.safeParse(value)
  if (!parsed.success) throw invalid("任务提交标识无效。")
  return parsed.data
}

export function parseTaskRequest(value: unknown): ParsedTaskRequest {
  const envelope = envelopeSchema.safeParse(value)
  if (!envelope.success) throw invalid("任务类型、项目或输入清单无效。")
  const definition = definitions[envelope.data.kind]
  const refs = definition.refs.safeParse(envelope.data.refs ?? {})
  if (!refs.success) throw invalid("任务输入清单无效。")
  const conditions = definition.conditions.safeParse(envelope.data.conditions ?? {})
  if (!conditions.success) throw invalid("任务条件无效。")
  assertProjectScope(envelope.data.projectId, refs.data)
  return {
    kind: envelope.data.kind,
    projectId: envelope.data.projectId,
    refs: refs.data as Record<string, unknown>,
    conditions: conditions.data as Record<string, unknown>,
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().filter(key => record[key] !== undefined)
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Input identity for idempotency: same key + same digest returns the original task. */
export function taskRequestDigest(request: ParsedTaskRequest): string {
  return digest(canonicalJson({ kind: request.kind, projectId: request.projectId, refs: request.refs, conditions: request.conditions }))
}

export function buildTaskManifest(request: ParsedTaskRequest, submittedBy: string, submittedAt: string): TaskManifest {
  return {
    version: 1,
    catalogVersion: TASK_CATALOG_VERSION,
    kind: request.kind,
    projectId: request.projectId,
    refs: request.refs,
    conditions: request.conditions,
    submittedBy,
    submittedAt,
  }
}

/** Canonical stored form so the manifest hash is reproducible after a restart. */
export function encodeManifest(manifest: TaskManifest): string {
  return canonicalJson(manifest)
}

export function manifestHash(encoded: string): string {
  return digest(encoded)
}

export function taskAttemptBudget(kind: TaskKind): { maxAttempts: number; maxCalls: number; maxCostFen: number } {
  return { maxAttempts: taskLimits.maxAttempts, maxCalls: maxCallsFor(kind), maxCostFen: maxCostFenFor(kind) }
}
