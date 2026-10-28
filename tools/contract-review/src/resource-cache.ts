import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

export type ResourceTextReader = (path: string) => Promise<string>
export const readResourceText: ResourceTextReader = async path => new TextDecoder("utf8", { fatal: true }).decode(await readFile(path))
export const resourceContentHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export type ResourceSnapshot<T> = { sha256: string; load: () => T }

/** Deployment resources only: keys come from current file contents, never document/session IDs or mtimes. */
export class ContentHashCache<T> {
  private readonly entries = new Map<string, T>()
  hits = 0
  misses = 0
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 128) throw new Error("资源缓存容量无效。")
  }
  get size() { return this.entries.size }
  getOrCreate(sha256: string, build: () => T): T {
    if (this.entries.has(sha256)) {
      this.hits++
      const value = this.entries.get(sha256)!
      this.entries.delete(sha256); this.entries.set(sha256, value)
      return structuredClone(value)
    }
    this.misses++
    // Failed construction is not cached. Neither the factory value nor the stored value escapes by reference.
    const value = structuredClone(build())
    this.entries.set(sha256, value)
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!)
    return structuredClone(value)
  }
}
