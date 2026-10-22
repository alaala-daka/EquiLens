import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve(process.env.SQLITE_PATH || "data/equilens.sqlite");
if (!process.argv[2]) throw new Error("Usage: node scripts/backup-sqlite.mjs <new backup path>");
const destination = resolve(process.argv[2]);
if (!existsSync(source)) throw new Error("SQLite database does not exist");
if (existsSync(destination) || source === destination) throw new Error("Backup destination must be a new file");
mkdirSync(dirname(destination), { recursive: true });
const database = new DatabaseSync(source, { readOnly: true });
try {
  await backup(database, destination);
  console.log("SQLite consistent backup completed");
} finally { database.close(); }
