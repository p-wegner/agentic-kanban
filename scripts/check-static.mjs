#!/usr/bin/env node
/**
 * `pnpm check:static` — the STATIC guard tier (#1514): `check:arch` plus every source-scanning
 * ratchet suite that declares itself with a `// @gate:static` line.
 *
 * Lint-like guards (god-module ceiling, console-tag ratchet, env-read ownership, worker-cli
 * isolation, always-run marker/runtime ratchets) are file scans: no DB, no verify worker, seconds
 * of work. They used to ride in the same verify chain as the test suites, so they reached the
 * builder last (at the train, after review) and a `held` verify placement meant they never ran at
 * all. This command is what the board runs at implement-exit OUTSIDE verify placement, and first at
 * the train gate, so a red here costs seconds and the builder / fix agent gets the exact message.
 *
 * `@gate:static` is an ADDITIONAL marker, on its own line, next to the suite's `@gate:always-run`
 * marker (a static suite is always an always-run suite: it reads state outside its import graph).
 * `static-gate-marker-ratchet.test.ts` enforces that pairing.
 *
 * Node built-ins + the local pnpm wrapper only, like `check-arch.mjs`: it must work before any
 * other script has run.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpm } from "./pnpm-exec.mjs";
import { listRepoSubdirs, walkRepoTree } from "./lib/repo-tree.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const STATIC_MARKER = "@gate:static";

const TEST_FILE = /\.test\.(ts|tsx|mts)$/;
const SKIP_DIRS = ["drizzle", "coverage"];

function walkTests(dir) {
  return walkRepoTree(dir, { skipDirs: SKIP_DIRS, filter: (full) => TEST_FILE.test(full) });
}

/** Does a test file's header (first 8 lines) carry the static marker as a `//` comment? */
export function declaresStatic(source) {
  return source
    .split(/\r?\n/, 8)
    .some((line) => line.trimStart().startsWith("//") && line.includes(STATIC_MARKER));
}

/** Repo-relative (forward-slash) paths of every `@gate:static` suite under `packages/*`. */
export function discoverStaticSuites(root = REPO_ROOT) {
  const found = [];
  const packagesDir = join(root, "packages");
  const packages = listRepoSubdirs(packagesDir);
  for (const pkg of packages) {
    for (const file of walkTests(pkg)) {
      let head;
      try {
        head = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (declaresStatic(head)) found.push(relative(root, file).replace(/\\/g, "/"));
    }
  }
  return found.sort();
}

/** `{ "packages/server": ["src/__tests__/x.test.ts"] }` — vitest runs per package, from its dir. */
export function groupByPackage(files) {
  const groups = {};
  for (const file of files) {
    const m = /^(packages\/[^/]+)\/(.+)$/.exec(file);
    if (!m) continue;
    (groups[m[1]] ??= []).push(m[2]);
  }
  return groups;
}

function awaitExit(child, label) {
  return new Promise((done) => {
    child.on("error", (err) => {
      console.error(`[check:static] could not start ${label}: ${err.message}`);
      done(1);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

export async function main() {
  const startedAt = Date.now();
  // 1. check:arch — god-module ceiling first inside it; its message already carries rule + fix.
  const archCode = await awaitExit(
    spawn(process.execPath, [join(REPO_ROOT, "scripts", "check-arch.mjs")], { cwd: REPO_ROOT, stdio: "inherit", windowsHide: true }),
    "check:arch",
  );
  if (archCode !== 0) {
    console.error(`[check:static] FAILED at check:arch (exit ${archCode})`);
    process.exit(archCode);
  }
  // 2. the tagged ratchet suites, one vitest per package.
  const suites = discoverStaticSuites();
  const groups = groupByPackage(suites);
  for (const [pkgDir, files] of Object.entries(groups)) {
    const code = await awaitExit(
      spawnPnpm(["exec", "vitest", "run", "--maxWorkers=2", ...files], { cwd: resolve(REPO_ROOT, pkgDir), stdio: "inherit" }),
      pkgDir,
    );
    if (code !== 0) {
      console.error(`[check:static] FAILED in ${pkgDir}: ${files.join(", ")}`);
      process.exit(1);
    }
  }
  console.log(`[check:static] green: check:arch + ${suites.length} static suite(s), ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[check:static] crashed:", err);
    process.exit(1);
  });
}
