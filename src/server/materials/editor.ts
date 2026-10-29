import { createHash, randomUUID } from "node:crypto"
import type { AuthIdentity } from "../auth/service"
import type { ProjectAccess, ProjectAction } from "../../lib/business/contracts"
import { BusinessError } from "../projects/errors"
import { documentObjectKey, type PrivateObjectStore } from "../storage/obs"
import type { MaterialRepository } from "./repository"
import { ProjectDocumentRepository, type ProjectDocument, type ProjectDocumentVersion } from "./document-repository"
import { uuid, parseBytes } from "./validation"

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const missing = () => new BusinessError("NOT_FOUND", "找不到该文档版本。")
const unavailable = () => new BusinessError("SERVICE_UNAVAILABLE", "文档存储暂不可用，请稍后重试。")
export type ProjectEditorDependencies = {
  repository: ProjectDocumentRepository; materials: MaterialRepository; store: PrivateObjectStore
  authorize(identity: AuthIdentity, projectId: string, action: ProjectAction): Promise<ProjectAccess>
  validate(bytes: Buffer): Promise<void>
  retentionUntil?(projectId: string): Promise<string>
}

export class ProjectEditorService {
  constructor(private readonly deps: ProjectEditorDependencies) {}
  async list(identity: AuthIdentity, projectId: string) {
    await this.access(identity, projectId, "read")
    return this.deps.repository.list(projectId)
  }
  async open(identity: AuthIdentity, projectId: string, documentId: string, versionId?: string) {
    const access = await this.access(identity, projectId, "read")
    uuid(documentId, "文档标识无效。")
    const document = await this.deps.repository.find(projectId, documentId)
    if (!document) throw missing()
    const version = await this.deps.repository.version(projectId, documentId, versionId ?? document.currentVersionId)
    if (!version) throw missing()
    return { document, version, canEdit: access.role !== "viewer" }
  }
  async content(identity: AuthIdentity, projectId: string, documentId: string, versionId: string) {
    const result = await this.open(identity, projectId, documentId, versionId)
    const object = await this.deps.store.get(result.version.objectKey).catch(() => { throw unavailable() })
    if (!object || object.sha256 !== result.version.sha256 || digest(object.bytes) !== result.version.sha256) throw unavailable()
    return { ...result, bytes: object.bytes }
  }
  async preflight(identity: AuthIdentity, projectId: string, documentId: string) {
    await this.access(identity, projectId, "edit")
    return this.open(identity, projectId, documentId)
  }
  async create(identity: AuthIdentity, projectId: string, materialId: string, materialVersionId: string) {
    await this.access(identity, projectId, "edit")
    uuid(materialId, "材料标识无效。")
    uuid(materialVersionId, "材料版本标识无效。")
    const material = await this.deps.materials.findMaterial(projectId, materialId)
    const original = await this.deps.materials.findVersion(projectId, materialId, materialVersionId)
    if (!material || material.status !== "active" || material.format !== "docx" || !original) throw missing()
    const id = randomUUID(), versionId = randomUUID(), now = new Date().toISOString()
    const document: ProjectDocument = { id, projectId, title: material.title, materialId, materialVersionId, currentVersionId: versionId, createdAt: now, updatedAt: now, copiedFrom: null }
    const version: ProjectDocumentVersion = { id: versionId, projectId, documentId: id, parentId: null, sha256: original.sha256, objectKey: original.objectKey, size: original.size, createdAt: now, operationId: randomUUID(), inputHash: digest(materialVersionId), editorVersion: "import" }
    await this.access(identity, projectId, "edit")
    await this.deps.repository.create(document, version)
    return { document, version, canEdit: true }
  }
  async save(identity: AuthIdentity, projectId: string, documentId: string, input: { baseVersionId: string; operationId: string; title: string; prompt?: string; editorVersion: string }, bytes: Uint8Array) {
    await this.preflight(identity, projectId, documentId)
    uuid(input.baseVersionId, "基础版本标识无效。")
    uuid(input.operationId, "操作标识无效。")
    this.checkInput(input)
    const content = parseBytes(bytes, 20 * 1024 * 1024)
    const sha256 = digest(content), inputHash = digest(JSON.stringify([input.baseVersionId, input.title, input.prompt ?? "", input.editorVersion, sha256]))
    const previous = await this.deps.repository.operation(projectId, documentId, input.operationId)
    if (previous) {
      if (previous.inputHash !== inputHash) throw new BusinessError("CONFLICT", "重复操作内容不一致。")
      return this.open(identity, projectId, documentId, previous.id)
    }
    await this.deps.validate(Buffer.from(content))
    const opened = await this.open(identity, projectId, documentId)
    if (opened.document.currentVersionId !== input.baseVersionId) throw new BusinessError("CONFLICT", "文档版本已更改，请另存为新文档。")
    const versionId = randomUUID(), now = new Date().toISOString()
    const key = documentObjectKey({ projectId, documentId, versionId, sha256 })
    if (!this.deps.retentionUntil) throw unavailable()
    await this.deps.repository.beginWrite({ id: versionId, projectId, objectKey: key, materialId: opened.document.materialId, materialVersionId: opened.document.materialVersionId, retentionUntil: await this.deps.retentionUntil(projectId) })
    const stored = await this.deps.store.put({ key, bytes: content, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }).catch(() => { throw unavailable() })
    if (stored.sha256 !== sha256) throw unavailable()
    const version: ProjectDocumentVersion = { id: versionId, projectId, documentId, parentId: input.baseVersionId, sha256, objectKey: key, size: content.length, createdAt: now, operationId: input.operationId, inputHash, editorVersion: input.editorVersion }
    await this.access(identity, projectId, "edit")
    const saved = await this.deps.repository.save({ ...opened.document, title: input.title, prompt: input.prompt ?? "", currentVersionId: versionId, updatedAt: now }, version, input.baseVersionId)
    if (saved.id !== versionId) await this.deps.store.delete(key).catch(() => { throw unavailable() })
    await this.deps.repository.completeWrite(versionId)
    return this.open(identity, projectId, documentId, saved.id)
  }
  async copy(identity: AuthIdentity, projectId: string, documentId: string, input: { baseVersionId: string; operationId: string; title: string; prompt?: string; editorVersion: string }, bytes: Uint8Array) {
    await this.preflight(identity, projectId, documentId)
    uuid(input.baseVersionId, "基础版本标识无效。")
    uuid(input.operationId, "操作标识无效。")
    this.checkInput(input)
    const source = await this.open(identity, projectId, documentId, input.baseVersionId)
    const content = parseBytes(bytes, 20 * 1024 * 1024), sha256 = digest(content)
    const inputHash = digest(JSON.stringify([documentId, input.baseVersionId, input.title, input.prompt ?? "", input.editorVersion, sha256]))
    const existing = await this.deps.repository.find(projectId, input.operationId)
    if (existing) {
      const version = await this.deps.repository.operation(projectId, existing.id, input.operationId)
      if (!version || version.inputHash !== inputHash) throw new BusinessError("CONFLICT", "重复操作内容不一致。")
      return this.open(identity, projectId, existing.id, version.id)
    }
    await this.deps.validate(Buffer.from(content))
    if (!this.deps.retentionUntil) throw unavailable()
    const id = input.operationId, versionId = randomUUID(), now = new Date().toISOString()
    const key = documentObjectKey({ projectId, documentId: id, versionId, sha256 })
    await this.deps.repository.beginWrite({ id: versionId, projectId, objectKey: key, materialId: source.document.materialId, materialVersionId: source.document.materialVersionId, retentionUntil: await this.deps.retentionUntil(projectId) })
    const stored = await this.deps.store.put({ key, bytes: content, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }).catch(() => { throw unavailable() })
    if (stored.sha256 !== sha256) throw unavailable()
    const document: ProjectDocument = { ...source.document, id, title: input.title, prompt: input.prompt ?? "", currentVersionId: versionId, createdAt: now, updatedAt: now, copiedFrom: { documentId, versionId: input.baseVersionId } }
    const version: ProjectDocumentVersion = { id: versionId, projectId, documentId: id, parentId: null, sha256, objectKey: key, size: content.length, createdAt: now, operationId: input.operationId, inputHash, editorVersion: input.editorVersion }
    await this.access(identity, projectId, "edit")
    const saved = await this.deps.repository.create(document, version)
    if (saved.id !== versionId) await this.deps.store.delete(key).catch(() => { throw unavailable() })
    await this.deps.repository.completeWrite(versionId)
    return this.open(identity, projectId, id, saved.id)
  }
  private checkInput(input: { title: string; prompt?: string; editorVersion: string }) {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 || typeof input.editorVersion !== "string" || input.editorVersion.length > 100 || (input.prompt !== undefined && (typeof input.prompt !== "string" || input.prompt.length > 10000))) throw new BusinessError("INVALID_INPUT", "文档信息无效。")
  }
  async repairWrites(limit = 10): Promise<number> {
    const pending = await this.deps.repository.pendingWrites(new Date(Date.now() - 600000).toISOString(), limit)
    let resolved = 0
    for (const intent of pending) {
      try {
        if (!await this.deps.repository.objectReferenced(intent.projectId, intent.objectKey)) await this.deps.store.delete(intent.objectKey)
        await this.deps.repository.completeWrite(intent.id)
        resolved++
      } catch { /* Keep pending for a later bounded retry. */ }
    }
    return resolved
  }
  private access(identity: AuthIdentity, projectId: string, action: ProjectAction) {
    uuid(projectId, "项目标识无效。")
    return this.deps.authorize(identity, projectId, action)
  }
}
