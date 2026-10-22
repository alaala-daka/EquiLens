import "server-only"
import { connectDatabase } from "../database/connection"
import { DocumentRepository } from "./repository"

const state = globalThis as typeof globalThis & { equilensRepository?: Promise<DocumentRepository> }
export function documentRepository() {
  state.equilensRepository ??= connectDatabase().then(db => new DocumentRepository(db)).catch(failure => {
    delete state.equilensRepository
    throw failure
  })
  return state.equilensRepository
}
