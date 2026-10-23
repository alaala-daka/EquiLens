import { build } from "esbuild";

await build({ entryPoints: ["scripts/anonymous-retention.mts"], bundle: true, platform: "node", format: "esm", target: "node24", external: ["gaussdb-node"], outfile: "scripts/generated/anonymous-retention.mjs" });
