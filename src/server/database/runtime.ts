import "server-only"
import { connectDatabase } from "./connection"
import { createDatabaseHolder } from "./runtime-core"

const state = globalThis as typeof globalThis & {
  equilensDatabaseHolder?: ReturnType<typeof createDatabaseHolder>
}

export function applicationDatabase() {
  state.equilensDatabaseHolder ??= createDatabaseHolder(connectDatabase)
  return state.equilensDatabaseHolder.get()
}
