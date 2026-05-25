import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const external = [
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/server/mcp.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "drizzle-orm",
  "drizzle-orm/libsql",
  "@libsql/client",
  "zod",
];

await build({
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external,
  // Don't use packages: "external" — @agentic-kanban/shared must be bundled in.
  entryPoints: [resolve(root, "packages/mcp-server/src/index.ts")],
  outfile: resolve(root, "packages/server/dist/mcp.js"),
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);",
  },
  plugins: [{
    name: "strip-shebang",
    setup(build) {
      build.onLoad({ filter: /index\.ts$/ }, async (args) => {
        const normalized = args.path.replace(/\\/g, "/");
        if (!normalized.includes("mcp-server/src/index.ts")) return null;
        const fs = await import("node:fs/promises");
        let source = await fs.readFile(args.path, "utf8");
        source = source.replace(/^#!.*\r?\n/, "");
        return { contents: source, loader: "ts" };
      });
    }
  }],
});

console.log("Built: packages/server/dist/mcp.js");
