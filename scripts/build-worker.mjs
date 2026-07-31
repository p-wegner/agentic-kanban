// Bundles the standalone worker entry (`agentic-kanban-worker`).
//
// Mirrors build-mcp.mjs: workspace code (@agentic-kanban/shared) is bundled in,
// real npm dependencies stay external. The bundle is deliberately tiny — a
// worker needs `ws`, `commander` and a handful of dependency-free helpers, and
// nothing in this graph may reach the database or the board services (that is
// the entire point of shipping a second binary; see src/worker/worker-cli.ts).

import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outfile = resolve(root, "packages/server/dist/worker.js");

await build({
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["ws", "commander"],
  entryPoints: [resolve(root, "packages/server/src/worker/worker-cli.ts")],
  outfile,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);",
  },
  plugins: [{
    name: "strip-shebang",
    setup(b) {
      b.onLoad({ filter: /worker-cli\.ts$/ }, async (args) => {
        const fs = await import("node:fs/promises");
        const source = (await fs.readFile(args.path, "utf8")).replace(/^#!.*\r?\n/, "");
        return { contents: source, loader: "ts" };
      });
    },
  }],
});

// Guard the reason this binary exists: if the bundle ever pulls in the database
// or board-server layer, the "no board install needed" promise is silently
// broken. Cheaper and more direct than asserting on the import graph.
const bundled = readFileSync(outfile, "utf8");
const forbidden = ["drizzle-orm", "@libsql/client", "@modelcontextprotocol/sdk", "@anthropic-ai/claude-agent-sdk", "hono"];
const leaked = forbidden.filter((dep) => bundled.includes(`"${dep}"`) || bundled.includes(`'${dep}'`));
if (leaked.length > 0) {
  console.error(`[build-worker] FAILED: the worker bundle reached board-only dependencies: ${leaked.join(", ")}`);
  console.error("  Something imported from src/worker/** now pulls in the server graph. Break that import.");
  process.exit(1);
}

console.log(`Built: packages/server/dist/worker.js (${(bundled.length / 1024).toFixed(0)} KB)`);
