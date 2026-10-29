import { createHash } from "node:crypto"

/**
 * Private object storage boundary (C2). Server-only callers persist originals
 * under unguessable project keys and proxy reads after rechecking project
 * authorization. There is deliberately no public-URL/presign method here.
 *
 * The real OBS adapter is an external gap: only the interface, a synthetic
 * store and a fault-injection wrapper are implemented in this package. Do not
 * present the synthetic store as verified OBS behaviour.
 */
export type ObjectStoreErrorCode = "UNAVAILABLE" | "CONFLICT" | "INVALID_KEY" | "INVALID_INPUT"

export class ObjectStoreError extends Error {
  constructor(readonly code: ObjectStoreErrorCode, message: string) {
    super(message)
    this.name = "ObjectStoreError"
  }
}

export type StoredObject = { key: string; sha256: string; size: number }
export type PrivateObject = StoredObject & { bytes: Uint8Array; contentType: string }

export type PrivateObjectStore = {
  put(input: { key: string; bytes: Uint8Array; contentType: string }): Promise<StoredObject>
  get(key: string): Promise<PrivateObject | null>
  delete(key: string): Promise<void>
}

const sha256Pattern = /^[0-9a-f]{64}$/
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Immutable object key; callers cannot inject traversal or a public URL. */
export function objectKey(input: { projectId: string; materialId: string; versionId: string; sha256: string }): string {
  if (!idPattern.test(input.projectId) || !idPattern.test(input.materialId) || !idPattern.test(input.versionId) || !sha256Pattern.test(input.sha256)) {
    throw new ObjectStoreError("INVALID_KEY", "对象标识无效。")
  }
  return `projects/${input.projectId}/materials/${input.materialId}/versions/${input.versionId}/${input.sha256}`
}

export function assertObjectKey(key: string): void {
  if (typeof key !== "string" || key.length > 512 || key.includes("..") || key.startsWith("/") || /[\u0000-\u001f\\:%]/.test(key)) {
    throw new ObjectStoreError("INVALID_KEY", "对象标识无效。")
  }
  const parts = key.split("/")
  if (parts.length !== 7 || parts[0] !== "projects" || parts[2] !== "materials" || parts[4] !== "versions") {
    throw new ObjectStoreError("INVALID_KEY", "对象标识无效。")
  }
  for (const part of [parts[1], parts[3], parts[5]]) if (!idPattern.test(part)) throw new ObjectStoreError("INVALID_KEY", "对象标识无效。")
  if (!sha256Pattern.test(parts[6])) throw new ObjectStoreError("INVALID_KEY", "对象标识无效。")
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export type SyntheticObjectStore = PrivateObjectStore & {
  readonly kind: "synthetic"
  keys(): readonly string[]
}

/** In-memory adapter for tests and for local synthetic material flows. */
export function createSyntheticObjectStore(): SyntheticObjectStore {
  const objects = new Map<string, PrivateObject>()
  return {
    kind: "synthetic",
    async put(input) {
      assertObjectKey(input.key)
      if (!(input.bytes instanceof Uint8Array) || !input.bytes.length) throw new ObjectStoreError("INVALID_INPUT", "对象内容无效。")
      if (typeof input.contentType !== "string" || !input.contentType || input.contentType.length > 128) throw new ObjectStoreError("INVALID_INPUT", "对象类型无效。")
      const sha256 = digest(input.bytes)
      const existing = objects.get(input.key)
      if (existing) {
        if (existing.sha256 !== sha256 || existing.contentType !== input.contentType) throw new ObjectStoreError("CONFLICT", "对象键已存在其他内容。")
        return { key: input.key, sha256, size: existing.size }
      }
      const bytes = new Uint8Array(input.bytes)
      objects.set(input.key, { key: input.key, bytes, sha256, size: bytes.byteLength, contentType: input.contentType })
      return { key: input.key, sha256, size: bytes.byteLength }
    },
    async get(key) {
      assertObjectKey(key)
      const value = objects.get(key)
      return value ? { ...value, bytes: new Uint8Array(value.bytes) } : null
    },
    async delete(key) {
      assertObjectKey(key)
      objects.delete(key)
    },
    keys() {
      return [...objects.keys()].sort()
    },
  }
}

export type FaultPlan = {
  /** Number of upcoming calls that fail before the adapter recovers. */
  put?: number
  get?: number
  delete?: number
}

/** Fault adapter: proves partial-failure residual handling without a real bucket. */
export function createFaultyObjectStore(inner: PrivateObjectStore, plan: FaultPlan): PrivateObjectStore {
  const remaining = { put: plan.put ?? 0, get: plan.get ?? 0, delete: plan.delete ?? 0 }
  const fail = (operation: keyof FaultPlan) => {
    if (remaining[operation] <= 0) return
    remaining[operation]--
    throw new ObjectStoreError("UNAVAILABLE", "对象存储暂不可用。")
  }
  return {
    async put(input) { fail("put"); return inner.put(input) },
    async get(key) { fail("get"); return inner.get(key) },
    async delete(key) { fail("delete"); return inner.delete(key) },
  }
}

/** Fail-closed placeholder until a verified private OBS adapter exists. */
export function createUnavailableObjectStore(): PrivateObjectStore {
  const unavailable = async (): Promise<never> => { throw new ObjectStoreError("UNAVAILABLE", "私有对象存储尚未配置。") }
  return { put: unavailable, get: unavailable, delete: unavailable }
}
