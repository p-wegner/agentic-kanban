import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distDir = resolve(root, "packages/server/dist");

// Clean dist directory before building
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const external = [
  "hono",
  "@hono/node-server",
  "@hono/node-ws",
  "@hono/node-server/serve-static",
  "drizzle-orm",
  "drizzle-orm/libsql/migrator",
  "drizzle-orm/libsql",
  "@libsql/client",
  "commander",
  "@modelcontextprotocol/sdk",
  "zod",
];

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external,
  // Don't use packages: "external" — we need @agentic-kanban/shared bundled in.
  // Required for __dirname / import.meta usage in source
  banner: {
    js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`,
  },
};

await build({
  ...shared,
  entryPoints: [resolve(root, "packages/server/src/cli/index.ts")],
  outfile: resolve(root, "packages/server/dist/cli.js"),
  // CLI is the main bin entry — needs shebang; source file has its own which esbuild strips
  banner: {
    js: "#!/usr/bin/env node\n" + shared.banner.js,
  },
  // Strip shebang from source — plugin handles it
  plugins: [{
    name: "strip-shebang",
    setup(build) {
      build.onLoad({ filter: /index\.ts$/ }, async (args) => {
        const normalized = args.path.replace(/\\/g, "/");
        if (!normalized.includes("server/src/cli/index.ts")) return null;
        const fs = await import("node:fs/promises");
        let source = await fs.readFile(args.path, "utf8");
        source = source.replace(/^#!.*\r?\n/, "");
        return { contents: source, loader: "ts" };
      });
    }
  }],
});

console.log("Built: packages/server/dist/cli.js");

await build({
  ...shared,
  entryPoints: [resolve(root, "packages/server/src/index.ts")],
  outfile: resolve(root, "packages/server/dist/server.js"),
});

console.log("Built: packages/server/dist/server.js");
