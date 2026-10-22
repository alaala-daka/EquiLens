import { cpSync } from "node:fs";

// Next.js traces the server; public and static assets must be bundled explicitly.
cpSync("public", ".next/standalone/public", { recursive: true });
cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
cpSync("THIRD_PARTY_NOTICES.md", ".next/standalone/THIRD_PARTY_NOTICES.md");
cpSync("licenses", ".next/standalone/licenses", { recursive: true });
cpSync("LICENSE", ".next/standalone/LICENSE");
cpSync("scripts/generated", ".next/standalone/scripts/generated", { recursive: true });
cpSync("scripts/backup-sqlite.mjs", ".next/standalone/scripts/backup-sqlite.mjs");
