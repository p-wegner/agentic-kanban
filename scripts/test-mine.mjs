#!/usr/bin/env node
// test:mine — the fast, opinionated unit-test loop for day-to-day iteration.
//
// Runs ONLY the suites that are reliably green in this environment (main checkout
// AND inside a git worktree). The known-flaky / pre-existing-broken suites listed
// in CLAUDE.md's "Known Flaky Test Suites" table are skipped so agents and humans
// stop chasing false failures. The full `pnpm test` stays for CI / pre-release.
//
// Why a wrapper instead of a single vitest invocation: the flaky suites live in
// two different packages (server + mcp-server), each with its own vitest config.
// This runs vitest once per package with the right `--exclude` globs and
// aggregates the exit codes.
//
// Why we invoke vitest's own entry directly (node <pkg>/node_modules/vitest/vitest.mjs)
// with cwd set to the package, instead of `pnpm --filter <pkg> test -- <args>`:
// forwarding flags through `pnpm run test -- ...` is unreliable on Windows. The
// nested `pnpm.cmd` shell shim mangles the `--` forward-separator, so the
// `--exclude` globs never reach vitest and the flaky suites run anyway. Calling
// vitest directly from the package dir lets its own `vitest.config.ts` resolve
// and the flags arrive verbatim. (Verified: this excludes the suites; the pnpm
// path did not.)
//
// Excluded suites (keep in sync with CLAUDE.md "Known Flaky Test Suites" and the
// "Use pnpm test:mine to skip these" note):
//   shared:
//     - git-service.integration.test.ts (#202) real git on temp dirs; Windows file-locking /
//       timing — same root cause as server's git.service.test.ts below. Measured: passes in
//       ~36s, fails on a 30s timeout in ~43s, no code change in between — pure timing flake.
//     - append-only-hotfile-merge.integration.test.ts, migration-renumber-conflict-guard.test.ts
//       — same #173 shape, found 2026-08-03 when they were failing EVERY pre-merge gate and so
//       blocking every merge on the board. Both are real-git-on-temp-dirs and both pass in
//       isolation (316s/5 tests and 152s/2 tests respectively) but exceed even a 240s per-test
//       timeout under full-suite parallelism. Raising their timeouts was already tried and is
//       not the answer: they are starved, not merely slow.
//   server:
//     - cli.test.ts        spawn-based CLI integration; stale migration list / worktree DB resolution
//     - cli-butler.test.ts spawn-based CLI integration; same root causes
//     - git.service.test.ts real git on temp dirs; Windows file-locking / timing
//     - done-unmerged-invariant-scanner.test.ts, workspace-merge-service.test.ts,
//       workspace-already-merged.test.ts, api-workspace.test.ts, workspace-lifecycle-transitions.test.ts,
//       merge-endpoint-reconcile-noop.test.ts, merge-service-edge-cases.test.ts, preferences.test.ts,
//       auto-review-pref.test.ts (#173) — every one of these is green in isolation; under full
//       parallelism a single file can hit CPU-contention timeouts of 15-17min, flaking the
//       merge gate red and (via #172) leaking a vitest worker fleet on each retry.
//     - worker-git-transport-e2e.test.ts — same #173 shape, arrived with the worker-fleet
//       epic (#188) and was never added here. It stands up TWO http listeners (board +
//       git-http) and does real `git clone`/`push` over the wire, so it is the heaviest
//       file in the package. Measured: 2/2 green in isolation on three consecutive runs
//       (~24s), but it failed the merge gate three times in a row under full-suite load
//       with `repo provisioning failed: git clone ...`. Still runs in the full `pnpm test`.
//     - compose-lifecycle-real-docker.test.ts (#164) — opt-in real-docker smoke test;
//       shells out to a real daemon and pulls/builds real images, so it's excluded from
//       the fast loop even on a machine with docker running. Run it via `pnpm test:docker`
//       (or the full `pnpm test`, which does include it — self-skips when docker is absent).
//   mcp-server:
//     - mcp-tools.test.ts  spawn-based MCP integration; stale migration list FIXED (reads journal dynamically).
//       Its catalog↔runtime parity gate has a fast NON-SPAWNING twin that DOES run here:
//       mcp-catalog-parity.test.ts (#982) — so parity breaks surface in this loop, not
//       only in the full `pnpm test`.
//
// Pass-through: any extra args are forwarded to vitest run in BOTH packages, so you can
// still narrow the run, e.g.:
//   pnpm test:mine -- --changed HEAD            (run tests for all git-changed files)
//   pnpm test:mine -- src/__tests__/tags.test.ts
// NOTE: vitest 4 removed the --related flag. Use `pnpm exec vitest related <file>`
// from inside the package dir to run tests that cover a specific source file.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** @type {{ dir: string, label: string, exclude: string[] }[]} */
const PACKAGES = [
  {
    dir: "packages/shared",
    label: "shared",
    exclude: [
      "**/git-service.integration.test.ts",
      // Same #173 shape as the server list below: real git on temp dirs, green in isolation,
      // starved under full-suite parallelism. Measured on master 2026-08-03, isolation vs the
      // merge gate's parallel run:
      //   append-only-hotfile-merge.integration  5 passed in 316s (~63s/test) -> TIMED OUT at 240s
      //   migration-renumber-conflict-guard      2 passed in 152s (~75s/test) -> TIMED OUT at 60s
      // They were failing EVERY pre-merge gate on this repo, so the gate blocked all merges
      // while providing no signal. Still run in the full `pnpm test`.
      "**/append-only-hotfile-merge.integration.test.ts",
      "**/migration-renumber-conflict-guard.test.ts",
    ],
  },
  {
    dir: "packages/server",
    label: "server",
    exclude: [
      "**/cli.test.ts",
      "**/cli-butler.test.ts",
      "**/git.service.test.ts",
      "**/done-unmerged-invariant-scanner.test.ts",
      "**/workspace-merge-service.test.ts",
      "**/workspace-already-merged.test.ts",
      "**/api-workspace.test.ts",
      "**/workspace-lifecycle-transitions.test.ts",
      "**/merge-endpoint-reconcile-noop.test.ts",
      "**/merge-service-edge-cases.test.ts",
      "**/preferences.test.ts",
      "**/auto-review-pref.test.ts",
      "**/worker-git-transport-e2e.test.ts",
      "**/compose-lifecycle-real-docker.test.ts",
    ],
  },
  {
    dir: "packages/mcp-server",
    label: "mcp-server",
    exclude: ["**/mcp-tools.test.ts"],
  },
];

// Extra args after `--` (pnpm strips the first `--`; node leaves the rest in argv).
const passthrough = process.argv.slice(2);

/**
 * Optional worker cap via `KANBAN_TEST_MAX_WORKERS` (#278).
 *
 * vitest defaults to `maxWorkers = cpus/2` with `pool: "forks"` and full isolation,
 * so each fork re-transforms its own module graph. When the pre-merge verify gate
 * runs on a box that is ALSO running a dev server, other worktrees' gates and the
 * agent itself, that fan-out is self-defeating: it multiplies peak memory and
 * process-spawn pressure, which is what produced the load-dependent timeouts that
 * made gates fail and retry (#218 failed 7 times over 4 days).
 *
 * Not set = vitest's own default, so interactive `pnpm test:mine` is unchanged.
 * The gate sets it explicitly (see `pre-merge-gate.service.ts`).
 *
 * A passthrough `--maxWorkers` on the command line wins — an explicit flag from the
 * caller must never be silently overridden by an env var.
 */
const maxWorkersRaw = (process.env.KANBAN_TEST_MAX_WORKERS || "").trim();
const callerSetWorkers = passthrough.some((a) => a.startsWith("--maxWorkers"));
const workerCapArgs =
  maxWorkersRaw && /^\d+$/.test(maxWorkersRaw) && !callerSetWorkers
    ? [`--maxWorkers=${maxWorkersRaw}`]
    : [];
if (maxWorkersRaw && !/^\d+$/.test(maxWorkersRaw)) {
  console.warn(`[test:mine] ignoring non-numeric KANBAN_TEST_MAX_WORKERS="${maxWorkersRaw}"`);
}

/**
 * Resolve vitest's runnable entry for a package. pnpm hoists most deps to the
 * workspace root, but each package may also have a local copy. Prefer the local
 * one, fall back to the root.
 */
function resolveVitestEntry(pkgDir) {
  const candidates = [
    resolve(pkgDir, "node_modules/vitest/vitest.mjs"),
    resolve(ROOT, "node_modules/vitest/vitest.mjs"),
  ];
  return candidates.find((p) => existsSync(p));
}

/**
 * Test files that must run for EVERY diff that reaches their package, because what they
 * check is not reachable through the module graph (#278).
 *
 * `vitest related <changed files>` selects tests that IMPORT the change. These suites import
 * nothing they check — they read the filesystem and assert a property of the tree: no raw git
 * spawn outside the adapter, no file over the god-module ceiling, no un-journaled migration,
 * no unregistered settings key, no `repoPath: "/repo"` in a suite that drives the real lock.
 * A change that breaks one of them is by definition a change none of their imports mention,
 * so file-level scoping would silently stop enforcing exactly the rules that exist because
 * review missed them once already.
 *
 * Only consulted when a run is file-scoped; a full-suite run includes them anyway.
 */
const ALWAYS_RUN_TESTS = {
  shared: [
    "__tests__/git-exec-single-spawn.test.ts",
    "__tests__/max-file-size.test.ts",
    "__tests__/barrel-client-safety.test.ts",
    "__tests__/settings-registry.test.ts",
  ],
  server: [
    "src/__tests__/migration-schema-drift.test.ts",
    "src/__tests__/status-write-ratchet.test.ts",
    "src/__tests__/settings-registry-keys.test.ts",
    "src/__tests__/repo-path-literal-ratchet.test.ts",
  ],
  "mcp-server": [
    "src/__tests__/mcp-catalog-parity.test.ts",
  ],
};

/**
 * File-level test scoping via `KANBAN_TEST_FILES` (comma-separated, repo-relative), the
 * gate's tier 1 (#278).
 *
 * `KANBAN_TEST_PACKAGES` is package-granular, so any diff touching `packages/server` — the
 * vast majority of board tickets — still paid the full ~4,165-test server suite. This narrows
 * that to `vitest related <the files the diff actually changed>`, which is dependency-aware:
 * vitest walks its own module graph and selects every suite that imports the change, directly
 * or transitively.
 *
 * Scoping applies only to a package the diff OWNS files in. A package that is in scope purely
 * as a downstream DEPENDENT (or via ALWAYS_RUN) has no changed files of its own to relate to,
 * and `vitest related` with someone else's paths would select nothing — so those packages
 * keep running their full suite. Same fail-open discipline as the package scope: unset, or a
 * value naming no file in a package, means "run everything for that package".
 */
const fileScopeRaw = (process.env.KANBAN_TEST_FILES || "").trim();
const scopedFiles = fileScopeRaw
  ? fileScopeRaw.split(",").map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean)
  : [];

/** The changed files under a package, as paths relative to that package's directory. */
function ownedChangedFiles(pkgDir) {
  const prefix = `${pkgDir.replace(/\\/g, "/")}/`;
  return scopedFiles
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length))
    // A deleted file cannot be related to anything and makes `vitest related` error out.
    .filter((rel) => existsSync(resolve(ROOT, pkgDir, rel)));
}

function runPackage({ dir, label, exclude }, mode = null) {
  return new Promise((resolvePromise) => {
    const pkgDir = resolve(ROOT, dir);
    const vitestEntry = resolveVitestEntry(pkgDir);
    if (!vitestEntry) {
      console.error(
        `[test:mine] ${label}: could not find vitest. Run \`pnpm install\` first.`
      );
      resolvePromise(1);
      return;
    }
    const excludeArgs = exclude.flatMap((glob) => ["--exclude", glob]);
    const modeArgs = mode?.kind === "related"
      ? ["related", ...mode.files, "--run", "--passWithNoTests"]
      : mode?.kind === "guards"
        ? ["run", ...mode.files, "--passWithNoTests"]
        : ["run"];
    const args = [vitestEntry, ...modeArgs, ...excludeArgs, ...workerCapArgs, ...passthrough];
    console.log(
      `\n[test:mine] ${label}: node vitest ${[...modeArgs, ...excludeArgs, ...workerCapArgs, ...passthrough].join(" ")}`
    );
    // No shell — pass argv as an array so globs reach vitest verbatim (vitest does
    // its own glob matching; the OS shell must NOT expand them). cwd = package dir
    // so vitest picks up that package's vitest.config.ts.
    const child = spawn(process.execPath, args, {
      cwd: pkgDir,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("exit", (code) => resolvePromise(code ?? 1));
    child.on("error", (err) => {
      console.error(`[test:mine] ${label} failed to start:`, err);
      resolvePromise(1);
    });
  });
}

/**
 * Optional package scoping via `KANBAN_TEST_PACKAGES` (comma-separated labels, e.g.
 * "shared,server").
 *
 * Set by the pre-merge gate (`pre-merge-gate.service.ts`) when it can prove from the diff
 * which workspace packages a branch touches. A client-only ticket then skips the ~507
 * server+mcp test files instead of paying for them, which is the difference between a
 * ~40-minute gate and a few minutes.
 *
 * Deliberately opt-IN and fail-open: an unset or unrecognised value runs everything, so a
 * plain `pnpm test:mine` and any caller that cannot determine scope are unaffected. The
 * gate only ever passes a scope it derived conservatively — see `scopedTestPackages`.
 */
const scopeRaw = (process.env.KANBAN_TEST_PACKAGES || "").trim();
const scopeLabels = scopeRaw ? new Set(scopeRaw.split(",").map((s) => s.trim()).filter(Boolean)) : null;
const selected = scopeLabels ? PACKAGES.filter((p) => scopeLabels.has(p.label)) : PACKAGES;
if (scopeLabels && selected.length === 0) {
  console.warn(`[test:mine] KANBAN_TEST_PACKAGES="${scopeRaw}" matched no known package — running ALL packages instead of silently testing nothing.`);
}
const toRun = selected.length > 0 ? selected : PACKAGES;
if (scopeLabels && toRun !== PACKAGES) {
  console.log(`[test:mine] scoped to: ${toRun.map((p) => p.label).join(", ")} (KANBAN_TEST_PACKAGES)`);
}

let failed = false;
for (const pkg of toRun) {
  const owned = scopedFiles.length > 0 ? ownedChangedFiles(pkg.dir) : [];
  if (owned.length === 0) {
    // Nothing of this package changed (or no file scope at all) — full suite, as before.
    if (await runPackage(pkg) !== 0) failed = true;
    continue;
  }
  console.log(`\n[test:mine] ${pkg.label}: file-scoped to ${owned.length} changed file(s) (KANBAN_TEST_FILES)`);
  if (await runPackage(pkg, { kind: "related", files: owned }) !== 0) failed = true;
  const guards = (ALWAYS_RUN_TESTS[pkg.label] ?? []).filter((f) => existsSync(resolve(ROOT, pkg.dir, f)));
  if (guards.length > 0 && await runPackage(pkg, { kind: "guards", files: guards }) !== 0) failed = true;
}

if (failed) {
  console.error("\n[test:mine] One or more packages had failing tests.");
  process.exit(1);
}
console.log("\n[test:mine] All reliable suites passed.");
