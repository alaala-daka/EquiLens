import type { PublishedRef } from "../../lib/business/contracts"
import type { TaskKind } from "./catalog"
import { TaskError } from "./errors"

/**
 * Server-resolved publication basis for task manifests (round-five C6).
 *
 * The browser may never submit these references: `submitTask` asks the
 * registered resolver after authentication and request parsing, and only the
 * resulting `pinned` value is written into the immutable manifest. Three states
 * keep missing/blocked bases fail-closed:
 * - `pinned`: exactly one published immutable version (per category) applies —
 *   the task records those refs and must not fall back to file rules.
 * - `none`: no publication history exists at all for this kind/scene, so the
 *   pre-existing debug/unsigned path stays available.
 * - `blocked`: history exists but is pending/disabled/ambiguous — reject before
 *   persistence instead of silently downgrading to debug.
 *
 * Registration is explicit (Node lifecycle); a missing resolver is a service
 * error, never a silent debug fallback.
 */
export type PublicationPin = Readonly<{
  rules: readonly PublishedRef[]
  knowledge: readonly PublishedRef[]
  templates: readonly PublishedRef[]
}>

export type PublicationResolution =
  | { state: "pinned"; pin: PublicationPin }
  | { state: "none" }
  | { state: "blocked"; reason: string }

export type PublicationResolverInput = {
  kind: TaskKind
  projectId: string
  refs: Record<string, unknown>
  conditions: Record<string, unknown>
}

export type PublicationResolver = (input: PublicationResolverInput) => Promise<PublicationResolution>

const runtime = globalThis as typeof globalThis & { equilensPublicationResolver?: PublicationResolver }

export function registerPublicationResolver(resolver: PublicationResolver): void {
  runtime.equilensPublicationResolver = resolver
}

/** Test/maintenance helper; production registration happens once in the Node lifecycle. */
export function clearPublicationResolver(): void {
  delete runtime.equilensPublicationResolver
}

export function publicationResolverRegistered(): boolean {
  return typeof runtime.equilensPublicationResolver === "function"
}

function unavailable(): TaskError {
  return new TaskError(503, "SERVICE_UNAVAILABLE", "发布依据服务暂不可用。")
}

function assertResolution(value: unknown): PublicationResolution {
  if (!value || typeof value !== "object") throw unavailable()
  const resolution = value as { state?: unknown }
  if (resolution.state === "none") return { state: "none" }
  if (resolution.state === "blocked") {
    const reason = (value as { reason?: unknown }).reason
    if (typeof reason !== "string" || !reason.trim() || reason.length > 200) throw unavailable()
    return { state: "blocked", reason: reason.trim() }
  }
  if (resolution.state === "pinned") {
    const pin = (value as { pin?: unknown }).pin
    if (!pin || typeof pin !== "object") throw unavailable()
    const record = pin as Record<string, unknown>
    for (const key of ["rules", "knowledge", "templates"] as const) {
      const refs = record[key]
      if (!Array.isArray(refs) || !refs.every(item => {
        if (!item || typeof item !== "object") return false
        const ref = item as Record<string, unknown>
        return typeof ref.id === "string" && !!ref.id && typeof ref.versionId === "string" && !!ref.versionId &&
          typeof ref.sha256 === "string" && /^[a-f0-9]{64}$/.test(ref.sha256)
      })) throw unavailable()
    }
    return { state: "pinned", pin: { rules: record.rules as PublishedRef[], knowledge: record.knowledge as PublishedRef[], templates: record.templates as PublishedRef[] } }
  }
  throw unavailable()
}

export async function resolvePublication(input: PublicationResolverInput): Promise<PublicationResolution> {
  const resolver = runtime.equilensPublicationResolver
  if (!resolver) throw unavailable()
  try {
    return assertResolution(await resolver(input))
  } catch (failure) {
    if (failure instanceof TaskError) throw failure
    throw unavailable()
  }
}
