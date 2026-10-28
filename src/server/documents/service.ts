import "server-only"
import { applicationDatabase } from "../database/runtime"
import { DocumentRepository } from "./repository"
import { DocumentSessionRepository } from "./session-repository"
import { retentionPolicy } from "./retention-policy"
import { retentionRuntimeReady } from "./retention-cleanup"

export type DocumentServices = { documents: DocumentRepository; sessions: DocumentSessionRepository }
type InitializedDocumentServices = DocumentServices & { database: Awaited<ReturnType<typeof applicationDatabase>> }
const state = globalThis as typeof globalThis & { equilensDocumentServices?: Promise<InitializedDocumentServices> }

async function createDocumentServices(): Promise<InitializedDocumentServices> {
  const database = await applicationDatabase()
  const sessions = new DocumentSessionRepository(database, {
    now: () => new Date(),
    readPolicy: () => { try { return retentionPolicy() } catch { return null } },
  })
  return { database, sessions, documents: new DocumentRepository(database, sessions) }
}

export function initializeDocumentServices(): Promise<InitializedDocumentServices> {
  state.equilensDocumentServices ??= createDocumentServices().catch(failure => {
    delete state.equilensDocumentServices
    throw failure
  })
  return state.equilensDocumentServices
}

export async function documentServices(): Promise<DocumentServices> {
  await retentionRuntimeReady()
  return initializeDocumentServices()
}

export async function documentReviewServices() {
  await retentionRuntimeReady()
  return initializeDocumentServices()
}

export async function documentRepository() { return (await documentServices()).documents }
