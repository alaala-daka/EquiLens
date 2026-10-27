import { build } from "esbuild";

await build({ entryPoints: ["src/server/documents/parse-worker.ts"], bundle: true, platform: "node", format: "esm", target: "node24", outfile: "scripts/generated/docx-validator.mjs" });
await build({ entryPoints: ["tools/contract-review/src/document-worker.ts"], bundle: true, platform: "node", format: "esm", target: "node24", outfile: "scripts/generated/contract-reader.mjs" });
await build({ entryPoints: ["tools/contract-review/src/revision-worker.ts"], bundle: true, platform: "node", format: "esm", target: "node24", outfile: "scripts/generated/contract-revision-renderer.mjs" });
