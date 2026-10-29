import type { Database } from "./connection"

/** Owns one lazy connection; closing the holder is terminal. */
export function createDatabaseHolder(connect: () => Promise<Database>) {
  let database: Promise<Database> | undefined
  let closed = false
  let closing: Promise<void> | undefined

  return {
    get(): Promise<Database> {
      if (closed) return Promise.reject(new Error("Database holder is closed"))
      database ??= Promise.resolve().then(connect).catch(failure => {
        database = undefined
        throw failure
      })
      return database
    },
    close(): Promise<void> {
      closed = true
      closing ??= (async () => {
        const connected = await database?.catch(() => undefined)
        await connected?.close()
      })()
      return closing
    },
  }
}
