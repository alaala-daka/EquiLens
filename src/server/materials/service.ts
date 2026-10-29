import { createHash } from "node:crypto"
import type { ProjectAccess, ProjectAction } from "../../lib/business/contracts"
import type { AuthIdentity } from "../auth/service"
import { BusinessError } from "../projects/errors"
import { objectKey, ObjectStoreError, type PrivateObjectStore, type StoredObject } from "../storage/obs"
import { MATERIAL_LIMITS, ParseFailure, detectMaterialFormat, parseMaterial } from "./parse"
import type { MaterialRepository } from "./repository"
import type {
  MaterialReadResult, MaterialRecord, MaterialSummary, MaterialVersionRecord, ParseCoverage, ParseSnapshotReadResult,
  ParseSnapshotRecord, ParsedFragment, RegisterMaterialResult, SourceFragmentRecord, SourceReadResult,
} from "./types"
import { parseBytes, parseRegistration, today, uuid } from "./validation"
import type { UploadIntent } from "./upload-intents"

const docxContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const pdfContentType = "application/pdf"

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const unavailable = (message = "材料存储暂不可用，请稍后重试。") => new BusinessError("SERVICE_UNAVAILABLE", message)

export type MaterialServiceDependencies = {
  repository: MaterialRepository
  store: PrivateObjectStore
  /** C1 guard factory result; every read/write rechecks the current session and membership. */
  requireProjectAccess: (identity: AuthIdentity, projectId: string, action: ProjectAction) => Promise<ProjectAccess>
  readProject: (projectId: string) => Promise<{ retentionUntil: string } | null>
  now?: () => Date
  enqueueParse?: (intent: UploadIntent) => Promise<string>
}

type Parsed = { coverage: ParseCoverage; fragments: ParsedFragment[]; parser: string; parserVersion: string }

/**
 * Private material registration, immutable parse snapshots and authorized
 * source reads. Originals live in the private object store; every read method
 * re-enters requireProjectAccess and never serves another project's object.
 */
export class MaterialService {
  private readonly now: () => Date

  constructor(private readonly deps: MaterialServiceDependencies) {
    this.now = deps.now ?? (() => new Date())
  }

  async registerMaterial(identity: AuthIdentity, body: unknown, bytes: unknown): Promise<RegisterMaterialResult> {
    const projectId = registrationProjectId(body)
    const access = await this.authorize(identity, projectId, "edit")
    const project = await this.deps.readProject(projectId)
    if (!project) throw new BusinessError("NOT_FOUND", "找不到该项目。")
    const registration = parseRegistration(body, project.retentionUntil, today(this.now()))
    const content = parseBytes(bytes, MATERIAL_LIMITS.fileBytes)
    const format = detectMaterialFormat(content)
    if (format !== "docx" && format !== "pdf") {
      throw new BusinessError("INVALID_SOURCE", format === "image" ? "证照图片 OCR 尚未验证，当前仅接受 DOCX 与文字 PDF。" : "文件类型不受支持，当前仅接受 DOCX 与文字 PDF。")
    }
    const sha256 = digest(content)
    const duplicate = await this.deps.repository.findByDigest(projectId, sha256)
    if (duplicate) {
      const snapshot = await this.deps.repository.latestSnapshot(projectId, duplicate.material.id)
      if (!snapshot) throw unavailable("材料解析快照缺失，请重新解析。")
      return { material: duplicate.material, version: duplicate.version, snapshot, coverage: snapshot.coverage, duplicate: true }
    }

    const parsed = this.extract(format, content)
    const materialId = this.deps.repository.newId()
    const versionId = this.deps.repository.newId()
    const snapshotId = this.deps.repository.newId()
    const createdAt = this.now().toISOString()
    const contentType = format === "docx" ? docxContentType : pdfContentType
    const key = objectKey({ projectId, materialId, versionId, sha256 })
    const intents = this.deps.repository.uploadIntents()
    const intent = await intents.begin({ projectId, materialId, versionId, objectKey: key, accountId: access.identity.account.id, sourceKind: registration.sourceKind, sourceReference: registration.sourceReference, processingAuthorized: true, purpose: registration.purpose, retentionUntil: registration.retentionUntil })
    let stored: StoredObject
    try {
      stored = await this.deps.store.put({ key, bytes: content, contentType })
      await intents.stored(intent.id)
    } catch (failure) {
      if (failure instanceof ObjectStoreError && failure.code === "INVALID_KEY") throw new BusinessError("INVALID_SOURCE", "材料对象标识无效。")
      throw unavailable()
    }
    if (stored.sha256 !== sha256) {
      await this.cleanup(key, projectId, "对象摘要不一致")
      throw new BusinessError("INVALID_SOURCE", "材料摘要校验失败，请重试。")
    }
    const material: MaterialRecord = {
      id: materialId, projectId, title: registration.title, fileName: registration.fileName, format,
      sourceKind: registration.sourceKind, sourceReference: registration.sourceReference, processingAuthorized: true,
      purpose: registration.purpose, retentionUntil: registration.retentionUntil, status: "active",
      latestRevision: 1, latestVersionId: versionId, createdBy: access.identity.account.id, createdAt,
    }
    const version: MaterialVersionRecord = {
      id: versionId, projectId, materialId, revision: 1, sha256, size: content.byteLength,
      contentType, objectKey: key, fileName: registration.fileName, createdAt,
    }
    const snapshot: ParseSnapshotRecord = {
      id: snapshotId, projectId, materialId, versionId, revision: 1, parser: parsed.parser,
      parserVersion: parsed.parserVersion, coverage: parsed.coverage, createdAt,
    }
    try {
      await this.deps.repository.create({ material, version, snapshot, fragments: this.fragments(projectId, snapshotId, parsed.fragments) })
    } catch (failure) {
      await this.cleanup(key, projectId, "材料登记写入失败")
      if (failure instanceof BusinessError) throw failure
      throw unavailable()
    }
    await intents.committed(intent.id)
    return { material, version, snapshot, coverage: parsed.coverage, duplicate: false }
  }

  /** Reparse creates a new immutable snapshot; historical snapshots and references stay readable. */
  async reparseMaterial(identity: AuthIdentity, projectIdValue: unknown, materialIdValue: unknown): Promise<{ snapshot: ParseSnapshotRecord; coverage: ParseCoverage }> {
    const projectId = uuid(projectIdValue, "项目标识无效。")
    const materialId = uuid(materialIdValue, "材料标识无效。")
    await this.authorize(identity, projectId, "edit")
    const material = await this.deps.repository.findMaterial(projectId, materialId)
    if (!material || material.status !== "active") throw new BusinessError("NOT_FOUND", "找不到该材料。")
    const version = await this.deps.repository.latestVersion(projectId, materialId)
    if (!version) throw new BusinessError("NOT_FOUND", "找不到该材料的原件版本。")
    let bytes: Uint8Array
    try {
      const object = await this.deps.store.get(version.objectKey)
      if (!object) throw unavailable("原件读取失败，未改写历史解析快照。")
      if (object.sha256 !== version.sha256 || digest(object.bytes) !== version.sha256) throw unavailable("原件校验失败，未改写历史解析快照。")
      bytes = object.bytes
    } catch (failure) {
      if (failure instanceof BusinessError) throw failure
      throw unavailable("原件读取失败，未改写历史解析快照。")
    }
    const parsed = this.extract(material.format, bytes)
    const revision = material.latestRevision + 1
    const snapshot: ParseSnapshotRecord = {
      id: this.deps.repository.newId(), projectId, materialId, versionId: version.id, revision,
      parser: parsed.parser, parserVersion: parsed.parserVersion, coverage: parsed.coverage, createdAt: this.now().toISOString(),
    }
    try {
      await this.deps.repository.addSnapshot(snapshot, this.fragments(projectId, snapshot.id, parsed.fragments), material.latestRevision)
    } catch (failure) {
      if (failure instanceof BusinessError) throw failure
      throw unavailable("解析快照保存失败，请稍后重试。")
    }
    return { snapshot, coverage: parsed.coverage }
  }

  async readMaterialVersion(identity: AuthIdentity, ref: { projectId?: unknown; materialId?: unknown; versionId?: unknown }): Promise<MaterialReadResult> {
    const projectId = uuid(ref?.projectId, "项目标识无效。")
    const materialId = uuid(ref?.materialId, "材料标识无效。")
    const versionId = uuid(ref?.versionId, "材料版本标识无效。")
    await this.authorize(identity, projectId, "read")
    const material = await this.deps.repository.findMaterial(projectId, materialId)
    if (!material || material.status !== "active") throw new BusinessError("NOT_FOUND", "找不到该材料。")
    const version = await this.deps.repository.findVersion(projectId, materialId, versionId)
    if (!version) throw new BusinessError("NOT_FOUND", "找不到该材料版本。")
    let object: Awaited<ReturnType<PrivateObjectStore["get"]>>
    try {
      object = await this.deps.store.get(version.objectKey)
    } catch {
      throw unavailable("原件暂不可用，请稍后重试。")
    }
    if (!object || object.sha256 !== version.sha256 || digest(object.bytes) !== version.sha256) throw unavailable("原件暂不可用，请稍后重试。")
    return { material, version, bytes: object.bytes, contentType: version.contentType, fileName: version.fileName }
  }

  async readParseSnapshot(identity: AuthIdentity, ref: { projectId?: unknown; snapshotId?: unknown }): Promise<ParseSnapshotReadResult> {
    const projectId = uuid(ref?.projectId, "项目标识无效。")
    const snapshotId = uuid(ref?.snapshotId, "解析快照标识无效。")
    await this.authorize(identity, projectId, "read")
    const snapshot = await this.deps.repository.findSnapshot(projectId, snapshotId)
    if (!snapshot) throw new BusinessError("NOT_FOUND", "找不到该解析快照。")
    const material = await this.deps.repository.findMaterial(projectId, snapshot.materialId)
    const version = await this.deps.repository.findVersion(projectId, snapshot.materialId, snapshot.versionId)
    if (!material || material.status !== "active" || !version) throw new BusinessError("NOT_FOUND", "找不到该解析快照。")
    return { snapshot, material, version }
  }

  async readSource(identity: AuthIdentity, ref: { projectId?: unknown; snapshotId?: unknown; fragmentId?: unknown }): Promise<SourceReadResult> {
    const projectId = uuid(ref?.projectId, "项目标识无效。")
    const snapshotId = uuid(ref?.snapshotId, "解析快照标识无效。")
    const fragmentId = uuid(ref?.fragmentId, "来源片段标识无效。")
    await this.authorize(identity, projectId, "read")
    const snapshot = await this.deps.repository.findSnapshot(projectId, snapshotId)
    if (!snapshot) throw new BusinessError("NOT_FOUND", "找不到该解析快照。")
    const fragment = await this.deps.repository.findFragment(projectId, snapshotId, fragmentId)
    if (!fragment || fragment.snapshotId !== snapshotId) throw new BusinessError("NOT_FOUND", "找不到该来源片段。")
    const material = await this.deps.repository.findMaterial(projectId, snapshot.materialId)
    if (!material || material.status !== "active") throw new BusinessError("NOT_FOUND", "找不到该来源片段。")
    return { snapshot, fragment }
  }

  async listMaterials(identity: AuthIdentity, projectIdValue: unknown): Promise<MaterialSummary[]> {
    const projectId = uuid(projectIdValue, "项目标识无效。")
    await this.authorize(identity, projectId, "read")
    return this.deps.repository.listMaterials(projectId)
  }

  /** Server-only maintenance: retry deletion of objects left by failed registrations. */
  async repairResidues(limit = 10): Promise<{ resolved: number; remaining: number }> {
    const intents = await this.deps.repository.uploadIntents().repair({
      store: this.deps.store,
      isReferenced: intent => this.deps.repository.objectReferenced(intent.objectKey),
      enqueueParse: this.deps.enqueueParse,
    }, { limit })
    const residues = await this.deps.repository.openResidues(Math.max(1, Math.min(100, Math.trunc(limit))))
    let resolved = 0
    for (const residue of residues) {
      try {
        if (!await this.deps.repository.objectReferenced(residue.objectKey)) await this.deps.store.delete(residue.objectKey)
        await this.deps.repository.resolveResidue(residue.id)
        resolved++
      } catch {
        await this.deps.repository.recordResidueFailure(residue.id).catch(() => undefined)
      }
    }
    return { resolved: resolved + intents.resolved, remaining: Math.max(0, residues.length - resolved) + intents.remaining }
  }

  private extract(format: "docx" | "pdf", bytes: Uint8Array): Parsed {
    try {
      const parsed = parseMaterial({ bytes, format })
      return { coverage: parsed.coverage, fragments: parsed.fragments, parser: parsed.parser, parserVersion: parsed.parserVersion }
    } catch (failure) {
      if (!(failure instanceof ParseFailure)) throw failure
      if (failure.code === "LIMIT_EXCEEDED") throw new BusinessError("LIMIT_EXCEEDED", failure.message)
      if (failure.coverage) {
        return { coverage: failure.coverage, fragments: [], parser: format === "docx" ? "docx-ooxml" : "pdf-text", parserVersion: format === "docx" ? "c2-docx-1" : "c2-pdf-1" }
      }
      throw new BusinessError("INVALID_SOURCE", failure.message)
    }
  }

  private fragments(projectId: string, snapshotId: string, parsed: ParsedFragment[]): SourceFragmentRecord[] {
    return parsed.map(fragment => ({
      id: this.deps.repository.newId(), projectId, snapshotId, kind: fragment.kind, order: fragment.order,
      page: fragment.page, paragraph: fragment.paragraph, headingPath: fragment.headingPath,
      tableIndex: fragment.tableIndex, row: fragment.row, column: fragment.column, text: fragment.text,
    }))
  }

  private async authorize(identity: AuthIdentity, projectId: string, action: ProjectAction): Promise<ProjectAccess> {
    try {
      return await this.deps.requireProjectAccess(identity, projectId, action)
    } catch (failure) {
      if (failure instanceof BusinessError) throw failure
      throw unavailable("项目授权检查暂不可用，请稍后重试。")
    }
  }

  private async cleanup(key: string, projectId: string, reason: string): Promise<void> {
    try {
      if (!await this.deps.repository.objectReferenced(key)) await this.deps.store.delete(key)
    } catch {
      try {
        await this.deps.repository.recordResidue(projectId, key, reason)
      } catch {
        console.error("Material residual object could not be recorded")
      }
    }
  }
}

function registrationProjectId(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BusinessError("INVALID_INPUT", "材料登记信息不完整或格式无效。")
  return uuid((body as Record<string, unknown>).projectId, "项目标识无效。")
}
