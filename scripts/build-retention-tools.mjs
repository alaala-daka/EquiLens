import { build } from "esbuild";

await build({ entryPoints: ["scripts/anonymous-retention.mts"], bundle: true, platform: "node", format: "esm", target: "node24", external: ["gaussdb-node"], outfile: "scripts/generated/anonymous-retention.mjs" });
// C7 private project lifecycle maintenance (inspect|reclaim|replay). Bundled so the
// container can run it without tsx, matching the anonymous retention CLI.
await build({ entryPoints: ["scripts/project-lifecycle.mts"], bundle: true, platform: "node", format: "esm", target: "node24", external: ["gaussdb-node"], outfile: "scripts/generated/project-lifecycle.mjs" });
