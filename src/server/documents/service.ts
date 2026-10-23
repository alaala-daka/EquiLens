import "server-only"
import { connectDatabase } from "../database/connection"
import { DocumentRepository } from "./repository"

const state = globalThis as typeof globalThis & { equilensRepository?: Promise<DocumentRepository> }
const databaseState = globalThis as typeof globalThis & { equilensDocumentDatabase?: ReturnType<typeof connectDatabase> }
export function documentDatabase() {
  databaseState.equilensDocumentDatabase ??= connectDatabase().catch(failure => {
    delete databaseState.equilensDocumentDatabase
    throw failure
  })
  return databaseState.equilensDocumentDatabase
}
export function documentRepository() {
  state.equilensRepository ??= documentDatabase().then(db => new DocumentRepository(db)).catch(failure => {
    delete state.equilensRepository
    throw failure
  })
  return state.equilensRepository
}
