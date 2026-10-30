import { build } from "esbuild"

await build({
  entryPoints: ["src/server/materials/parser-worker.ts"],
  outfile: "scripts/generated/material-parser.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
})
