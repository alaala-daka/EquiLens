import "server-only"
import { createSyntheticObjectStore, createUnavailableObjectStore, type PrivateObjectStore } from "./obs"

const state = globalThis as typeof globalThis & { equilensSyntheticStore?: PrivateObjectStore }

/** Explicit development opt-in only; production always fails closed. */
export function privateObjectStoreRuntime(): PrivateObjectStore {
  if (process.env.NODE_ENV !== "development" || process.env.EQUILENS_SYNTHETIC_STORAGE !== "1") return createUnavailableObjectStore()
  return state.equilensSyntheticStore ??= createSyntheticObjectStore()
}
