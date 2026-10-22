import { build } from "esbuild";

await build({ entryPoints: ["src/server/documents/parse-worker.ts"], bundle: true, platform: "node", format: "esm", target: "node24", outfile: "scripts/generated/docx-validator.mjs" });
