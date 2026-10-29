import "server-only"
import { resolve } from "node:path"
import { createFileObjectStore } from "./file-store"
import { createUnavailableObjectStore, type PrivateObjectStore } from "./obs"

const state = globalThis as typeof globalThis & {
  equilensDevObjectStore?: { root: string; store: PrivateObjectStore }
}

/**
 * Explicit development opt-in only; production always fails closed.
 *
 * With the opt-in the adapter is filesystem-backed (default `data/dev-objects`)
 * so a dev-server restart keeps object bytes that database rows still point
 * to. It remains a local development adapter, not a verified OBS substitute.
 */
export function privateObjectStoreRuntime(): PrivateObjectStore {
  if (process.env.NODE_ENV !== "development" || process.env.EQUILENS_SYNTHETIC_STORAGE !== "1") return createUnavailableObjectStore()
  const root = resolve(process.env.EQUILENS_DEV_OBJECT_STORE ?? "data/dev-objects")
  if (state.equilensDevObjectStore?.root === root) return state.equilensDevObjectStore.store
  const store = createFileObjectStore(root)
  state.equilensDevObjectStore = { root, store }
  return store
}
