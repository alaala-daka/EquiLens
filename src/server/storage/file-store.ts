import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { assertObjectKey, ObjectStoreError, type PrivateObject, type PrivateObjectStore, type StoredObject } from "./obs"

/**
 * Development-only filesystem object store. It keeps private object bytes on
 * the local disk so a dev-server restart does not lose materials, saved
 * document versions or exports while their database rows survive.
 *
 * This is not an OBS adapter: it has no bucket auth, versioning, lifecycle,
 * cross-instance or backup semantics. `privateObjectStoreRuntime` still refuses
 * it outside explicit development configuration, and production stays
 * fail-closed.
 */

const headerVersion = 1
const maxHeaderBytes = 2048
const sha256Pattern = /^[0-9a-f]{64}$/

export type FileObjectStore = PrivateObjectStore & { readonly kind: "file"; readonly root: string }

type FileHeader = {
  version: number
  key: string
  sha256: string
  size: number
  contentType: string
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function corrupt(): ObjectStoreError {
  return new ObjectStoreError("UNAVAILABLE", "对象数据校验失败。")
}

function unavailable(): ObjectStoreError {
  return new ObjectStoreError("UNAVAILABLE", "对象存储暂不可用。")
}

function parseHeader(payload: Uint8Array, key: string): { bytes: Uint8Array; header: FileHeader } {
  const split = payload.indexOf(0x0a)
  if (split <= 0 || split > maxHeaderBytes) throw corrupt()
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(payload.subarray(0, split)).toString("utf8"))
  } catch {
    throw corrupt()
  }
  if (typeof value !== "object" || value === null) throw corrupt()
  const header = value as Record<string, unknown>
  if (header.version !== headerVersion || header.key !== key) throw corrupt()
  if (typeof header.sha256 !== "string" || !sha256Pattern.test(header.sha256)) throw corrupt()
  if (typeof header.size !== "number" || !Number.isSafeInteger(header.size) || header.size < 0) throw corrupt()
  if (typeof header.contentType !== "string" || !header.contentType || header.contentType.length > 128) throw corrupt()
  const bytes = new Uint8Array(payload.subarray(split + 1))
  if (bytes.byteLength !== header.size || digest(bytes) !== header.sha256) throw corrupt()
  return { bytes, header: header as FileHeader }
}

export function createFileObjectStore(root: string): FileObjectStore {
  const rootPath = resolve(root)

  function pathFor(key: string): string {
    assertObjectKey(key)
    const target = join(rootPath, ...key.split("/"))
    if (!target.startsWith(rootPath + sep)) throw new ObjectStoreError("INVALID_KEY", "对象标识无效。")
    return target
  }

  async function read(target: string, key: string): Promise<PrivateObject | null> {
    let payload: Buffer
    try {
      payload = await readFile(target)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null
      throw unavailable()
    }
    const { bytes, header } = parseHeader(payload, key)
    return { key, sha256: header.sha256, size: header.size, contentType: header.contentType, bytes }
  }

  return {
    kind: "file",
    root: rootPath,
    async put(input) {
      const target = pathFor(input.key)
      if (!(input.bytes instanceof Uint8Array) || !input.bytes.length) throw new ObjectStoreError("INVALID_INPUT", "对象内容无效。")
      if (typeof input.contentType !== "string" || !input.contentType || input.contentType.length > 128) throw new ObjectStoreError("INVALID_INPUT", "对象类型无效。")
      const sha256 = digest(input.bytes)
      const existing = await read(target, input.key)
      if (existing) {
        if (existing.sha256 !== sha256 || existing.contentType !== input.contentType) throw new ObjectStoreError("CONFLICT", "对象键已存在其他内容。")
        return { key: input.key, sha256, size: existing.size }
      }
      const header: FileHeader = { version: headerVersion, key: input.key, sha256, size: input.bytes.byteLength, contentType: input.contentType }
      const payload = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), Buffer.from(input.bytes)])
      try {
        await mkdir(dirname(target), { recursive: true })
      } catch {
        throw unavailable()
      }
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, payload)
        try {
          // link() never replaces an existing object, so concurrent writers cannot clobber immutable bytes.
          await link(temporary, target)
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw unavailable()
          const raced = await read(target, input.key)
          if (raced && raced.sha256 === sha256 && raced.contentType === input.contentType) return { key: input.key, sha256, size: raced.size }
          throw new ObjectStoreError("CONFLICT", "对象键已存在其他内容。")
        }
      } catch (error) {
        if (error instanceof ObjectStoreError) throw error
        throw unavailable()
      } finally {
        await unlink(temporary).catch(() => {})
      }
      return { key: input.key, sha256, size: input.bytes.byteLength } satisfies StoredObject
    },
    async get(key) {
      return read(pathFor(key), key)
    },
    async delete(key) {
      const target = pathFor(key)
      try {
        await unlink(target)
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw unavailable()
      }
    },
  }
}
