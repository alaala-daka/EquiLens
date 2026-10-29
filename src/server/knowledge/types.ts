import type { PublishedRef } from "../../lib/business/contracts"
import type { LoadedPack } from "../../../tools/contract-review/src/types"

/**
 * C6 controlled knowledge/rule publication storage (business migration 0011).
 *
 * The database stores one `publication` per stable `(kind, artifact_id)` and an
 * append-only list of immutable versions. Only the service layer enforces the
 * four-state machine and the review guards; the tables deliberately contain no
 * CHECK constraints so the same DDL applies to SQLite and GaussDB (spec/04).
 *
 * This round only defines the content contract and runtime consumer for
 * `rules` (published rule packs loaded by the contract-review executor). The
 * `knowledge` and `templates` categories exist in the shared schema for the
 * frozen `PublicationPin` shape, but have no accepted content contract or
 * formal-task consumer yet; `submit` rejects them instead of inventing one.
 */
export const publicationStates = ["draft", "pending_verification", "published", "disabled"] as const
export type PublicationState = (typeof publicationStates)[number]

export const publicationKinds = ["rules", "knowledge", "templates"] as const
export type PublicationKind = (typeof publicationKinds)[number]

/** Content categories this round can validate, submit and publish. */
export const supportedPublicationKinds: readonly PublicationKind[] = ["rules"]

export const publicationContentSchemaVersion = 1

/**
 * A published rule pack version exposes exactly the frozen `PublishedRef` shape:
 * `id` is the stable publication id, `versionId` the immutable version row.
 */
export type PublicationVersionRef = PublishedRef

export type PublicationRecord = {
  id: string
  kind: PublicationKind
  artifactId: string
  createdAt: string
}

export type PublicationVersionRecord = {
  id: string
  publicationId: string
  kind: PublicationKind
  artifactId: string
  version: string
  scene: string
  state: PublicationState
  sha256: string
  /** Parsed `payload_json`: `{schemaVersion, manifest, rules}` for rule packs. */
  payload: unknown
  /** Parsed `sources_json` (rule-pack source entries). */
  sources: unknown[]
  /** Parsed `applicability_json`: `{scene, role}` for rule packs. */
  applicability: Record<string, unknown>
  reviewer: string | null
  verifiedAt: string | null
  reviewEvidence: string | null
  publishedAt: string | null
  disabledAt: string | null
  disabledReason: string | null
  supersedesId: string | null
  createdBy: string
  createdAt: string
}

/** Redacted publication summary for the private maintenance CLI. Never includes content text. */
export type PublicationSummary = {
  publicationId: string
  kind: PublicationKind
  artifactId: string
  latestVersion: PublicationVersionSummary | null
  versions: PublicationVersionSummary[]
}

export type PublicationVersionSummary = {
  versionId: string
  publicationId: string
  kind: PublicationKind
  artifactId: string
  version: string
  scene: string
  state: PublicationState
  sha256: string
  reviewer: string | null
  verifiedAt: string | null
  publishedAt: string | null
  disabledAt: string | null
  createdAt: string
}

export type PublicationVersionDetail = PublicationVersionSummary & {
  reviewEvidence: string | null
  disabledReason: string | null
  supersedesId: string | null
  createdBy: string
  /** Structural summary only; rule/source text is not printed by the CLI. */
  content: {
    schemaVersion: number | null
    manifestName: string | null
    manifestVersion: string | null
    manifestStatus: string | null
    ruleCount: number
    sourceCount: number
    warnings: string[]
  }
}

/** One loaded immutable published rule pack plus its lifecycle state at read time. */
export type LoadedPublishedRulePack = {
  pack: LoadedPack
  scene: string
  /** The pinned version was disabled (superseded or manually retired) after presentation. */
  disabled: boolean
  publicationId: string
  versionId: string
  sha256: string
}

/** Validated content prepared for insertion; the stored digest covers all three columns. */
export type PreparedPublicationContent = {
  payload: unknown
  sources: unknown[]
  applicability: Record<string, unknown>
  /** Canonical JSON strings exactly as stored. */
  payloadJson: string
  sourcesJson: string
  applicabilityJson: string
  sha256: string
  pack: LoadedPack
  warnings: string[]
  publishBlockers: string[]
  manifestName: string
  manifestVersion: string
  manifestStatus: string
}
