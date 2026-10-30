import type { AuthService } from "../auth/service"
import {
  requireAllowedReviewer,
  requireExpectedSha256,
  requireReason,
  requireReviewEvidence,
  requireSuperAdminOperator,
  requireVerifiedAt,
} from "./access"
import {
  assertPublicationArtifactId,
  assertPublicationScene,
  prepareRulePackContent,
  publicationDigest,
  rulePackFromStored,
  storedContentSummary,
} from "./content"
import { KnowledgeError } from "./errors"
import { KnowledgeRepository } from "./repository"
import {
  publicationContentSchemaVersion,
  publicationKinds,
  supportedPublicationKinds,
  type PublicationKind,
  type PublicationState,
  type PublicationSummary,
  type PublicationVersionDetail,
  type PublicationVersionRecord,
  type PublicationVersionSummary,
} from "./types"

/**
 * C6 controlled publication state machine.
 *
 * States: draft → pending_verification → published → disabled.
 * - draft/pending versions may be created without reviewer, verified time or
 *   evidence (those columns stay nullable).
 * - `publish` requires: existing enabled superadmin operator, allowlisted
 *   reviewer (EQUILENS_DOMAIN_REVIEWERS), reviewer != operator, exact expected
 *   digest, verification time and review evidence; missing/invalid values are
 *   rejected without changing the stored state.
 * - a published version is immutable; correction submits a new version and
 *   conditionally disables the previous published version.
 * - `disable` retires a published version and keeps the full history.
 *
 * The repository performs the final conditional updates (changes === 1); this
 * service does all authorization, content and digest validation before them.
 */
export type PublicationServiceDependencies = {
  repository: KnowledgeRepository
  auth: Pick<AuthService, "account">
  env: Record<string, string | undefined>
  now?: () => Date
}

export type SubmitPublicationInput = {
  kind: PublicationKind
  artifactId: string
  scene: string
  /** Raw JSON document read from the private operator's input file. */
  content: string
  operatorId: string
  /** Optional: create the version already assigned for verification. */
  reviewer?: string
}

export type PublishPublicationInput = {
  versionId: string
  operatorId: string
  reviewer: string
  verifiedAt: string
  expectedSha256: string
  reviewEvidence: string
}

export type DisablePublicationInput = {
  versionId: string
  operatorId: string
  reason: string
}

export type ValidatePublicationResult = {
  kind: PublicationKind
  scene: string
  sha256: string
  manifestName: string
  manifestVersion: string
  manifestStatus: string
  ruleCount: number
  sourceCount: number
  warnings: string[]
  publishBlockers: string[]
  publishable: boolean
}

const numericVersion = (value: string) => /^\d+$/.test(value) ? Number(value) : -1

function summary(version: PublicationVersionRecord): PublicationVersionSummary {
  return {
    versionId: version.id,
    publicationId: version.publicationId,
    kind: version.kind,
    artifactId: version.artifactId,
    version: version.version,
    scene: version.scene,
    state: version.state,
    sha256: version.sha256,
    reviewer: version.reviewer,
    verifiedAt: version.verifiedAt,
    publishedAt: version.publishedAt,
    disabledAt: version.disabledAt,
    createdAt: version.createdAt,
  }
}

function latest(versions: PublicationVersionRecord[]): PublicationVersionRecord | null {
  return [...versions].sort((left, right) => numericVersion(right.version) - numericVersion(left.version))[0] ?? null
}

export class PublicationService {
  private readonly now: () => Date

  constructor(private readonly dependencies: PublicationServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
  }

  private async operator(operatorId: string) {
    return requireSuperAdminOperator(this.dependencies.auth, operatorId)
  }

  private async version(versionId: string): Promise<PublicationVersionRecord> {
    if (typeof versionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(versionId)) throw new KnowledgeError("NOT_FOUND")
    const version = await this.dependencies.repository.getVersion(versionId)
    if (!version) throw new KnowledgeError("NOT_FOUND")
    return version
  }

  private detail(version: PublicationVersionRecord): PublicationVersionDetail {
    return {
      ...summary(version),
      reviewEvidence: version.reviewEvidence,
      disabledReason: version.disabledReason,
      supersedesId: version.supersedesId,
      createdBy: version.createdBy,
      content: { schemaVersion: publicationContentSchemaVersion, ...storedContentSummary(version) },
    }
  }

  async list(filter: { kind?: string; artifactId?: string } = {}): Promise<PublicationSummary[]> {
    const kind = filter.kind === undefined ? undefined : this.publicationKind(filter.kind)
    const artifactId = filter.artifactId === undefined ? undefined : assertPublicationArtifactId(String(filter.artifactId))
    const rows = await this.dependencies.repository.list({ kind, artifactId })
    return rows.map(({ publication, versions }) => ({
      publicationId: publication.id,
      kind: publication.kind,
      artifactId: publication.artifactId,
      latestVersion: latest(versions) ? summary(latest(versions)!) : null,
      versions: [...versions].sort((left, right) => numericVersion(left.version) - numericVersion(right.version)).map(summary),
    }))
  }

  async showVersion(versionId: string): Promise<PublicationVersionDetail> {
    return this.detail(await this.version(versionId))
  }

  async showLatest(kindValue: string, artifactIdValue: string): Promise<PublicationVersionDetail> {
    const kind = this.publicationKind(kindValue)
    const artifactId = assertPublicationArtifactId(artifactIdValue)
    const publication = await this.dependencies.repository.findPublication(kind, artifactId)
    if (!publication) throw new KnowledgeError("NOT_FOUND")
    const versions = await this.dependencies.repository.versionsForPublication(publication.id)
    const target = latest(versions)
    if (!target) throw new KnowledgeError("NOT_FOUND")
    return this.detail(target)
  }

  /** Read-only content validation; no database write and no operator needed. */
  validate(kindValue: string, sceneValue: string, content: string): ValidatePublicationResult {
    const kind = this.publicationKind(kindValue)
    const scene = assertPublicationScene(sceneValue)
    const prepared = prepareRulePackContent(kind, scene, content)
    return {
      kind,
      scene,
      sha256: prepared.sha256,
      manifestName: prepared.manifestName,
      manifestVersion: prepared.manifestVersion,
      manifestStatus: prepared.manifestStatus,
      ruleCount: prepared.pack.rules.length,
      sourceCount: prepared.pack.sources.length,
      warnings: prepared.warnings,
      publishBlockers: prepared.publishBlockers,
      publishable: prepared.publishBlockers.length === 0,
    }
  }

  async submit(input: SubmitPublicationInput): Promise<PublicationVersionDetail> {
    const operator = await this.operator(input.operatorId)
    if (resultKind(input.kind) === null) {
      throw new KnowledgeError("INVALID_CONTENT", "本轮只定义了规则包（rules）的发布内容契约。")
    }
    const kind = resultKind(input.kind)!
    const artifactId = assertPublicationArtifactId(input.artifactId)
    const scene = assertPublicationScene(input.scene)
    const prepared = prepareRulePackContent(kind, scene, input.content)
    const reviewer = input.reviewer === undefined ? null
      : requireAllowedReviewer(this.dependencies.env, input.reviewer, operator)
    const created = await this.dependencies.repository.insertContentVersion({
      kind,
      artifactId,
      scene,
      state: reviewer ? "pending_verification" : "draft",
      payloadJson: prepared.payloadJson,
      sourcesJson: prepared.sourcesJson,
      applicabilityJson: prepared.applicabilityJson,
      sha256: prepared.sha256,
      reviewer,
      createdBy: operator.id,
    })
    return this.detail(created)
  }

  async publish(input: PublishPublicationInput): Promise<PublicationVersionDetail> {
    const operator = await this.operator(input.operatorId)
    const version = await this.version(input.versionId)
    if (!(supportedPublicationKinds as readonly string[]).includes(version.kind)) {
      throw new KnowledgeError("INVALID_CONTENT", "该发布类型尚未定义内容契约，不能发布。")
    }
    if (version.state !== "draft" && version.state !== "pending_verification") {
      throw new KnowledgeError("INVALID_STATE", "只有草稿或待核对版本可以发布。")
    }
    const reviewer = requireAllowedReviewer(this.dependencies.env, input.reviewer, operator)
    if (version.reviewer && version.reviewer !== reviewer) {
      throw new KnowledgeError("CONFLICT", "核对人与待核对版本登记不一致。")
    }
    const expectedSha256 = requireExpectedSha256(input.expectedSha256)
    if (expectedSha256 !== version.sha256) {
      throw new KnowledgeError("INVALID_CONTENT", "期望摘要与待发布版本不一致。")
    }
    const verifiedAt = requireVerifiedAt(input.verifiedAt, version.createdAt, this.now())
    const reviewEvidence = requireReviewEvidence(input.reviewEvidence)
    // Recompute the digest from stored columns: a tampered payload/source row can
    // never be published even if the version digest column was edited too.
    let storedSha256: string
    try {
      storedSha256 = publicationDigest(version.payload, version.sources, version.applicability)
    } catch {
      throw new KnowledgeError("INVALID_CONTENT", "存储内容无法重新计算摘要。")
    }
    if (storedSha256 !== version.sha256) throw new KnowledgeError("INVALID_CONTENT", "存储内容摘要与版本摘要不一致。")
    // Publish-grade content: only published sources may form a published pack.
    rulePackFromStored(version)
    const published = await this.dependencies.repository.publish({
      versionId: version.id,
      expectedState: version.state,
      reviewer,
      verifiedAt,
      reviewEvidence,
      publishedAt: this.now().toISOString(),
    })
    return this.detail(published)
  }

  async disable(input: DisablePublicationInput): Promise<PublicationVersionDetail> {
    await this.operator(input.operatorId)
    const version = await this.version(input.versionId)
    const reason = requireReason(input.reason)
    const disabled = await this.dependencies.repository.disable({
      versionId: version.id,
      disabledAt: this.now().toISOString(),
      reason,
    })
    return this.detail(disabled)
  }

  private publicationKind(value: string): PublicationKind {
    if (!(publicationKinds as readonly unknown[]).includes(value)) throw new KnowledgeError("INVALID_INPUT", "发布类型无效。")
    return value as PublicationKind
  }
}

function resultKind(value: unknown): PublicationKind | null {
  if (typeof value === "string" && (supportedPublicationKinds as readonly string[]).includes(value)) return value as PublicationKind
  return null
}

/** Types re-exported for CLI/test consumers without importing the repository directly. */
export type { PublicationKind, PublicationState, PublicationVersionRecord }
