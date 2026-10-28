import { createHash, randomUUID } from "node:crypto"
import type { MaterialServiceDependencies } from "./service"
import type { AuthIdentity } from "../auth/service"
import type { MaterialFormat, MaterialRecord, MaterialVersionRecord } from "./types"
import { BusinessError } from "../projects/errors"
import { detectMaterialFormat, MATERIAL_LIMITS } from "./parse"
import { parseBytes, parseRegistration, today, uuid } from "./validation"
import { objectKey } from "../storage/obs"

export type QueuedDependencies = MaterialServiceDependencies & {
  available: () => boolean
  preflight: (bytes: Uint8Array, format: MaterialFormat) => Promise<void>
  enqueue: (identity: AuthIdentity, version: MaterialVersionRecord, operationId: string) => Promise<string>
}
const unavailable = () => new BusinessError("SERVICE_UNAVAILABLE", "材料处理暂不可用，请稍后重试。")
const inflight = new Map<string, Promise<unknown>>()
let inflightBytes = 0

/** HTTP write path: validation is delegated; extraction belongs exclusively to the task executor. */
export class QueuedMaterialService {
  constructor(private readonly deps: QueuedDependencies) {}

  async upload(identity: AuthIdentity, projectId: string, body: unknown, value: unknown) {
    const bytes = parseBytes(value, MATERIAL_LIMITS.fileBytes)
    const key = `${identity.account.id}:${projectId}:${createHash("sha256").update(bytes).digest("hex")}`
    if (inflight.has(key) || inflight.size >= 4 || inflightBytes + bytes.length > 40 * 1024 * 1024) return Promise.reject(unavailable())
    // Reject overload immediately; never retain request buffers in a waiting queue.
    inflightBytes += bytes.length
    const tracker: { operation?: Promise<unknown>; settled?: boolean } = {}
    const release = () => { inflight.delete(key); inflightBytes -= bytes.length }
    const result = this.admit(identity, projectId, body, value, tracker).finally(() => {
      if (tracker.operation && !tracker.settled) void tracker.operation.then(release, release)
      else release()
    })
    inflight.set(key, result)
    return result
  }

  private async admit(identity: AuthIdentity, projectId: string, body: unknown, value: unknown, tracker: { operation?: Promise<unknown>; settled?: boolean }) {
    await this.deps.requireProjectAccess(identity, projectId, "edit")
    if (!this.deps.available()) throw unavailable()
    const project = await this.deps.readProject(projectId)
    if (!project) throw new BusinessError("NOT_FOUND", "找不到该项目。")
    const now = this.deps.now?.() ?? new Date()
    const registration = parseRegistration({ ...(body as object), projectId }, project.retentionUntil, today(now))
    const bytes = parseBytes(value, MATERIAL_LIMITS.fileBytes)
    const format = detectMaterialFormat(bytes)
    if (format !== "docx" && format !== "pdf") throw new BusinessError("INVALID_SOURCE", "文件类型不受支持。")
    await this.deps.preflight(bytes, format)
    await this.deps.requireProjectAccess(identity, projectId, "edit")
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const duplicate = await this.deps.repository.findByDigest(projectId, sha256)
    if (duplicate) {
      const parseTaskId = await this.deps.repository.parseTaskId(projectId, duplicate.material.id) ?? await this.submit(identity, duplicate.version, `material:${duplicate.version.id}`)
      return { ...duplicate, parseTaskId, duplicate: true }
    }
    const materialId = randomUUID(), versionId = randomUUID()
    const key = objectKey({ projectId, materialId, versionId, sha256 })
    const intents = this.deps.repository.uploadIntents()
    const intent = await intents.begin({ ...registration, materialId, versionId, objectKey: key, accountId: identity.account.id })
    const createdAt = now.toISOString()
    const material: MaterialRecord = { ...registration, id: materialId, format, status: "active", latestRevision: 0, latestVersionId: versionId, createdBy: identity.account.id, createdAt }
    const version: MaterialVersionRecord = { id: versionId, materialId, projectId, revision: 1, sha256, size: bytes.length, contentType: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", objectKey: key, fileName: registration.fileName, createdAt }
    try {
      const stored = await this.storePut({ key, bytes, contentType: version.contentType }, tracker)
      await intents.stored(intent.id)
      if (stored.sha256 !== sha256 || stored.size !== bytes.length) throw new BusinessError("INVALID_SOURCE", "材料摘要校验失败，请重试。")
      await this.deps.repository.create({ material, version })
      const parseTaskId = await this.submit(identity, version, `material:${version.id}`)
      await intents.committed(intent.id, parseTaskId)
      return { material, version, parseTaskId, duplicate: false }
    } catch (failure) {
      // Intent remains durable even if delete or metadata commit fails.
      if (failure instanceof BusinessError) throw failure
      throw unavailable()
    }
  }

  private async storePut(input: Parameters<QueuedDependencies["store"]["put"]>[0], tracker: { operation?: Promise<unknown>; settled?: boolean }) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const operation = this.deps.store.put(input)
      tracker.operation = operation
      void operation.then(() => { tracker.settled = true }, () => { tracker.settled = true })
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 30000) }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  }

  private async submit(identity: AuthIdentity, version: MaterialVersionRecord, operationId: string) {
    await this.deps.requireProjectAccess(identity, version.projectId, "edit")
    const taskId = await this.deps.enqueue(identity, version, operationId)
    await this.deps.repository.linkTask(version.projectId, version.materialId, taskId)
    return taskId
  }

  async reparse(identity: AuthIdentity, projectId: string, materialId: string, operationId: string) {
    await this.deps.requireProjectAccess(identity, projectId, "edit")
    if (!this.deps.available()) throw unavailable()
    uuid(materialId, "材料标识无效。")
    const version = await this.deps.repository.latestVersion(projectId, materialId)
    const material = await this.deps.repository.findMaterial(projectId, materialId)
    if (!version || !material || material.status !== "active") throw new BusinessError("NOT_FOUND", "找不到该材料。")
    return { parseTaskId: await this.submit(identity, version, operationId) }
  }
}
