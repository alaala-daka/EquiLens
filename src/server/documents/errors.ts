import type { AnonymousSessionView, DocumentSessionCode } from "../../lib/documents/session-types"
import type { Connection, Database } from "../database/connection"

class StoreErrorConstructor extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: DocumentSessionCode | "REVISION_CONFLICT",
    public readonly session?: AnonymousSessionView,
  ) { super(message) }
}

// Retrying this error must start a new transaction: a unique violation aborts a GaussDB transaction.
class SessionRegistrationRaceConstructor extends Error {}

// Next instrumentation and routes may evaluate separate bundles. Cached services must throw
// instances of the same constructors that route boundaries recognize; arbitrary shapes are faults.
const constructorsKey = Symbol.for("equilens.document-error-constructors.v1")
const globalErrors = globalThis as typeof globalThis & {
  [constructorsKey]?: { StoreError: typeof StoreErrorConstructor; SessionRegistrationRace: typeof SessionRegistrationRaceConstructor }
}
const constructors = globalErrors[constructorsKey] ??= { StoreError: StoreErrorConstructor, SessionRegistrationRace: SessionRegistrationRaceConstructor }
export const StoreError = constructors.StoreError
export type StoreError = InstanceType<typeof StoreError>
export const SessionRegistrationRace = constructors.SessionRegistrationRace

export async function sessionTransaction<T>(database: Database, work: (connection: Connection) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await database.transaction(work) }
    catch (failure) { if (!(failure instanceof SessionRegistrationRace) || attempt >= 2) throw failure }
  }
}
