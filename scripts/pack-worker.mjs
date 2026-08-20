// Produces an installable worker tarball WITHOUT going through npm publish.
//
// Why this exists: `agentic-kanban-worker` ships as a bin of the `agentic-kanban`
// package, but the registry copy lags the tree — 0.1.9 was published before the
// worker fleet (epic #184) landed, so `npm i -g agentic-kanban` installs a package
// whose bin map has no worker key at all. Pairing a new worker machine therefore
// blocked on a release. This script is the fast track: build, pack, hand over the
// file. Publishing stays a deliberate, separate decision.
//
// The version stamp is the load-bearing part. A plain `npm pack` here emits
// `agentic-kanban-0.1.9.tgz` — the SAME version string as the registry's, whose
// contents differ. npm may then resolve a cached 0.1.9 instead of the file it was
// handed and silently install the OLD two-bin package, which looks exactly like
// "the worker binary is missing" and sends you debugging the wrong thing. So we
// stamp a prerelease version (0.1.9-dev.<sha>) that cannot collide with anything
// in the registry or in a local cache.
//
// Usage:
//   node scripts/pack-worker.mjs                 # build + pack, print the path
//   node scripts/pack-worker.mjs --skip-build    # pack what is already in dist/
//   node scripts/pack-worker.mjs --blob          # also put it on the ACP relay
//
// --blob shells out to the ACP CLI (ACP_CLI env, else the default path below) and
// prints an `acp-blob:` ref for a cross-machine handoff. ACP is not a dependency
// of this repo — the coupling is one optional spawn, deliberately.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkgDir = join(root, "packages", "server");
const pkgJsonPath = join(pkgDir, "package.json");
const outDir = join(root, "dist-worker-pack");

const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const toBlob = args.has("--blob");

const ACP_CLI = process.env.ACP_CLI || "C:/projects/andrena/acp/acp.js";

// `npm` and `pnpm` are .cmd shims on Windows, which execFileSync cannot spawn
// without a shell (ENOENT). Quote args accordingly — paths here contain spaces.
const needsShell = process.platform === "win32";

function run(cmd, cmdArgs, cwd) {
  const args = needsShell ? cmdArgs.map((a) => (/[\s]/.test(a) ? `"${a}"` : a)) : cmdArgs;
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: needsShell,
  });
}

function shortSha() {
  try {
    return run("git", ["rev-parse", "--short", "HEAD"], root).trim();
  } catch {
    return "nogit";
  }
}

if (!skipBuild) {
  console.log("[pack-worker] building (pnpm build)…");
  // Inherit stdio: the build is slow and its progress is the only feedback.
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit", shell: needsShell });
}

const original = readFileSync(pkgJsonPath, "utf8");
const pkg = JSON.parse(original);

// Refuse to ship a tarball whose bin map lacks the very binary this exists for.
// A silently worker-less tarball is the failure mode that cost a round trip.
if (!pkg.bin || !pkg.bin["agentic-kanban-worker"]) {
  console.error("[pack-worker] packages/server/package.json has no `agentic-kanban-worker` bin — refusing to pack.");
  process.exit(1);
}

const stamped = `${pkg.version}-dev.${shortSha()}`;
mkdirSync(outDir, { recursive: true });

let tarball;
try {
  writeFileSync(pkgJsonPath, JSON.stringify({ ...pkg, version: stamped }, null, 2) + "\n");
  const out = run("npm", ["pack", "--pack-destination", outDir], pkgDir);
  tarball = join(outDir, out.trim().split("\n").pop().trim());
} finally {
  // Always restore, including on a failed pack — a mutated version left in the
  // working tree would be committed by the next unrelated commit.
  writeFileSync(pkgJsonPath, original);
}

console.log(`[pack-worker] ${tarball}`);
console.log(`[pack-worker] version ${stamped} (prerelease — cannot collide with the registry's ${pkg.version})`);
console.log(`[pack-worker] install on the worker machine:  npm i -g "${tarball}"`);
console.log(`[pack-worker] then verify:  agentic-kanban-worker --version`);

if (toBlob) {
  const res = run("node", [ACP_CLI, "blob", "put", tarball, "--mime", "application/gzip"], root);
  console.log(`[pack-worker] relay: ${res.trim()}`);
  console.log("[pack-worker] blobs expire after 30 minutes — have the worker fetch it now.");
}
