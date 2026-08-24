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
//   node scripts/pack-worker.mjs                 # build (no React client) + pack, print the path
//   node scripts/pack-worker.mjs --with-client   # ALSO build the React client (a full `pnpm build`)
//   node scripts/pack-worker.mjs --skip-build    # pack what is already in dist/
//   node scripts/pack-worker.mjs --blob          # also put it on the ACP relay
//   node scripts/pack-worker.mjs --print-acp     # resolve the ACP CLI, print it, exit
//
// The default build DELIBERATELY SKIPS the React client (#845). The worker daemon is
// `packages/server/dist/worker.js`; it never loads the UI, so a client-only failure —
// a corrupt rollup binary in the pnpm store is the one that actually happened — used
// to block pairing a worker machine entirely. Pass `--with-client` when the tarball is
// meant to serve the board UI too.
//
// --blob shells out to the ACP CLI and prints an `acp-blob:` ref for a cross-machine
// handoff. ACP is not a dependency of this repo — the coupling is one optional spawn,
// deliberately. Where the CLI is found: see resolveAcpCli() (#844 — it used to be one
// machine's absolute checkout path, which broke the one flag built for OTHER machines).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join, delimiter, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkgDir = join(root, "packages", "server");
const pkgJsonPath = join(pkgDir, "package.json");
const outDir = join(root, "dist-worker-pack");

const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const withClient = args.has("--with-client");
const toBlob = args.has("--blob");
const printAcp = args.has("--print-acp");

// `npm` and `pnpm` are .cmd shims on Windows, which execFileSync cannot spawn
// without a shell (ENOENT). Quote args accordingly — paths here contain spaces.
const needsShell = process.platform === "win32";

function run(cmd, cmdArgs, cwd) {
  const quoted = needsShell ? cmdArgs.map((a) => (/[\s]/.test(a) ? `"${a}"` : a)) : cmdArgs;
  return execFileSync(cmd, quoted, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: needsShell,
  });
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// --- ACP CLI resolution (#844) -------------------------------------------------
// No absolute path of any one machine. Order: explicit env, then PATH, then the acp
// skill as installed into an agent profile, then a sibling checkout of this repo.
function acpCandidatePaths() {
  const out = [];
  const home = homedir();
  // The acp skill is junctioned into each agent profile's skills/ dir.
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.name.startsWith(".claude") || entry.name === ".codex") {
        out.push(join(home, entry.name, "skills", "acp", "acp.js"));
      }
    }
  } catch {
    /* unreadable home — just skip this source */
  }
  // A sibling checkout: <parent-of-this-repo>/acp/acp.js, and one level further up.
  out.push(resolve(root, "..", "acp", "acp.js"));
  out.push(resolve(root, "..", "..", "acp", "acp.js"));
  return out;
}

function lookupOnPath() {
  const names = process.platform === "win32" ? ["acp.cmd", "acp.exe", "acp.bat", "acp.js", "acp"] : ["acp", "acp.js"];
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Returns `{ command, args, source }`, or exits 1 with a message naming ACP_CLI. */
function resolveAcpCli() {
  const explicit = process.env.ACP_CLI;
  if (explicit) {
    if (!isFile(explicit)) {
      console.error(`[pack-worker] ACP_CLI is set to "${explicit}", but there is no file at that path.`);
      console.error("[pack-worker] Point ACP_CLI at the acp entry point (acp.js) or at an `acp` executable.");
      process.exit(1);
    }
    return { ...spawnShapeFor(explicit), source: "ACP_CLI" };
  }

  const onPath = lookupOnPath();
  if (onPath) return { ...spawnShapeFor(onPath), source: "PATH" };

  const candidates = acpCandidatePaths();
  for (const candidate of candidates) {
    if (isFile(candidate)) return { ...spawnShapeFor(candidate), source: "discovered" };
  }

  console.error("[pack-worker] --blob needs the ACP CLI and none could be found on this machine.");
  console.error("[pack-worker] Set ACP_CLI to the acp entry point, e.g.:");
  console.error("[pack-worker]   ACP_CLI=/path/to/acp/acp.js node scripts/pack-worker.mjs --blob");
  console.error("[pack-worker] ACP_CLI may name an acp.js file or an `acp` executable.");
  console.error("[pack-worker] Looked on PATH for `acp`, and at:");
  for (const candidate of candidates) console.error(`[pack-worker]   ${candidate}`);
  console.error("[pack-worker] (--blob is only the relay hop: without it pack-worker still writes the tarball to copy across.)");
  process.exit(1);
}

/** A .js/.mjs entry point runs under node; anything else is spawned as an executable. */
function spawnShapeFor(cliPath) {
  const ext = extname(cliPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { command: "node", args: [cliPath] };
  return { command: cliPath, args: [] };
}

if (printAcp) {
  const acp = resolveAcpCli();
  console.log(`[pack-worker] acp CLI (${acp.source}): ${[acp.command, ...acp.args].join(" ")}`);
  process.exit(0);
}

// Resolve BEFORE the build so a missing ACP CLI costs a second, not a full build.
const acpCli = toBlob ? resolveAcpCli() : null;

function shortSha() {
  try {
    return run("git", ["rev-parse", "--short", "HEAD"], root).trim();
  } catch {
    return "nogit";
  }
}

// Mirrors the root `build` script's steps, minus the client unless asked (#845).
function buildSteps() {
  const steps = [
    { script: "build:shared", what: "shared" },
    { script: "build:server", what: "server" },
    { script: "build:mcp", what: "mcp" },
    { script: "build:worker", what: "worker daemon" },
  ];
  if (withClient) steps.push({ script: "build:client", what: "React client" });
  return steps;
}

if (!skipBuild) {
  const steps = buildSteps();
  const stepList = steps.map((s) => s.what).join(", ");
  const clientNote = withClient
    ? ""
    : " — the React client is NOT built (a worker never loads it); pass --with-client to include it";
  console.log(`[pack-worker] building: ${stepList}${clientNote}`);
  for (const step of steps) {
    try {
      // Inherit stdio: the build is slow and its progress is the only feedback.
      execFileSync("pnpm", ["run", step.script], { cwd: root, stdio: "inherit", shell: needsShell });
    } catch {
      console.error(`[pack-worker] build step failed: pnpm run ${step.script} (${step.what}).`);
      if (step.script === "build:client") {
        console.error("[pack-worker] The worker daemon does NOT need the React client — re-run WITHOUT --with-client to");
        console.error("[pack-worker] get a worker tarball anyway.");
      } else {
        console.error("[pack-worker] If dist/ already holds a good build, re-run with --skip-build to pack it as-is.");
      }
      process.exit(1);
    }
  }
  // copy-assets stages migrations + scaffold hooks into server/dist. It warns (does not
  // fail) when packages/client/dist is absent, which is exactly the no-client case.
  execFileSync("node", [join("scripts", "copy-assets.mjs")], { cwd: root, stdio: "inherit", shell: needsShell });
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
if (!skipBuild && !withClient) {
  console.log("[pack-worker] note: no React client in this tarball — it is a worker build (--with-client for the full UI).");
}
console.log(`[pack-worker] install on the worker machine:  npm i -g "${tarball}"`);
console.log(`[pack-worker] then verify:  agentic-kanban-worker --version`);

if (toBlob) {
  const res = run(acpCli.command, [...acpCli.args, "blob", "put", tarball, "--mime", "application/gzip"], root);
  console.log(`[pack-worker] relay: ${res.trim()}`);
  console.log("[pack-worker] blobs expire after 30 minutes — have the worker fetch it now.");
}
