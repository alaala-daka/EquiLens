import { readFileSync } from "node:fs"

export function databaseConfig(env: Record<string, string | undefined> = process.env) {
  const provider = env.DATABASE_PROVIDER ?? "sqlite"
  if (provider === "sqlite") return { provider, path: env.SQLITE_PATH ?? "data/equilens.sqlite" } as const
  if (provider !== "gaussdb") throw new Error("DATABASE_PROVIDER must be sqlite or gaussdb")
  for (const key of ["HOST", "DATABASE", "USER", "PASSWORD"]) {
    if (!env[`GAUSSDB_${key}`]) throw new Error(`GAUSSDB_${key} is required`)
  }
  const port = Number(env.GAUSSDB_PORT ?? 8000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid GAUSSDB_PORT")
  return { provider, connection: {
    host: env.GAUSSDB_HOST!, port, database: env.GAUSSDB_DATABASE!, user: env.GAUSSDB_USER!, password: env.GAUSSDB_PASSWORD!,
    ssl: { rejectUnauthorized: true, ...(env.GAUSSDB_CA_PATH ? { ca: readFileSync(/* turbopackIgnore: true */ env.GAUSSDB_CA_PATH, "utf8") } : {}) },
    max: 4, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
  } } as const
}
